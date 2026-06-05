import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  sessions,
  events,
  controls,
  sessionStatusSchema,
  eventTypeSchema,
  controlTypeSchema,
  parseEventPayload,
  parseControlPayload,
  imageAttachmentSchema,
} from '@steer/schema'
import type { Db } from './db.js'
import { type Tx, WriteError, assertOwns, captureTxid } from './session-tx.js'
import './types.js'

const bodySchema = z.object({
  collection: z.enum(['sessions', 'events', 'controls']),
  op: z.enum(['insert', 'update', 'delete']),
  payload: z.record(z.unknown()),
})

async function applyWrite(
  tx: Tx,
  userId: string,
  collection: 'sessions' | 'events' | 'controls',
  op: 'insert' | 'update' | 'delete',
  payload: Record<string, unknown>,
): Promise<void> {
  if (collection === 'sessions') {
    if (op === 'insert') {
      const p = z
        .object({
          id: z.string().min(1),
          title: z.string().min(1),
          task: z.string().optional(),
          model: z.string().optional(),
          // The environment to route this session to (the user's routing intent).
          environment: z.string().min(1).optional(),
          // The absolute directory the session should run in (the CLI's cwd). Stored
          // verbatim; the owning daemon confines it to its root, so an out-of-root
          // path is harmless here (untrusted-but-stored, like environment).
          workdir: z.string().min(1).optional(),
          // An optional image attached to the initial task (R14, vision input).
          // Validated by the shared schema, which enforces the `image/*` MIME rule
          // AND the size cap here at the write boundary so an over-cap or non-image
          // payload is rejected with a clear ZodError rather than persisted. Never
          // log its bytes. Absent = unchanged (the common no-image path).
          image: imageAttachmentSchema.optional(),
        })
        .parse(payload)
      // user_id is injected server-side; any client-supplied user_id is ignored.
      // claimed_by is likewise never accepted here — only the trusted daemon sets it.
      await tx.insert(sessions).values({
        id: p.id,
        userId,
        title: p.title,
        task: p.task ?? null,
        model: p.model ?? 'sonnet',
        environment: p.environment ?? null,
        workdir: p.workdir ?? null,
        taskImage: p.image ?? null,
        lastStatus: 'starting',
      })
      return
    }
    if (op === 'update') {
      const p = z
        .object({
          id: z.string().min(1),
          title: z.string().min(1).optional(),
          lastStatus: sessionStatusSchema.optional(),
          model: z.string().optional(),
        })
        .parse(payload)
      await assertOwns(tx, userId, p.id)
      await tx
        .update(sessions)
        .set({
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.lastStatus !== undefined ? { lastStatus: p.lastStatus } : {}),
          ...(p.model !== undefined ? { model: p.model } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, p.id))
      return
    }
    // delete
    const p = z.object({ id: z.string().min(1) }).parse(payload)
    await assertOwns(tx, userId, p.id)
    await tx.delete(sessions).where(eq(sessions.id, p.id))
    return
  }

  if (collection === 'controls') {
    if (op !== 'insert') throw new WriteError(400, 'controls are insert-only via this endpoint')
    const p = z
      .object({
        id: z.string().min(1).optional(),
        sessionId: z.string().min(1),
        type: controlTypeSchema,
        payload: z.record(z.unknown()),
      })
      .parse(payload)
    await assertOwns(tx, userId, p.sessionId)
    const validated = parseControlPayload(p.type, p.payload)
    await tx
      .insert(controls)
      .values({ id: p.id ?? randomUUID(), sessionId: p.sessionId, type: p.type, payload: validated })
    return
  }

  // events (append-only)
  if (op !== 'insert') throw new WriteError(400, 'events are append-only')
  const p = z
    .object({
      sessionId: z.string().min(1),
      seq: z.number().int().nonnegative(),
      type: eventTypeSchema,
      payload: z.record(z.unknown()),
    })
    .parse(payload)
  await assertOwns(tx, userId, p.sessionId)
  const validated = parseEventPayload(p.type, p.payload)
  await tx.insert(events).values({ sessionId: p.sessionId, seq: p.seq, type: p.type, payload: validated })
}

export function registerWrites(app: FastifyInstance, db: Db): void {
  app.post('/writes', async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', detail: parsed.error.flatten() })
    }
    const { collection, op, payload } = parsed.data
    try {
      const txid = await db.transaction(async (tx) => {
        await applyWrite(tx, req.userId, collection, op, payload)
        return captureTxid(tx)
      })
      return reply.send({ txid })
    } catch (err) {
      if (err instanceof WriteError) return reply.code(err.status).send({ error: err.message })
      if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid payload', detail: err.flatten() })
      return reply.code(400).send({ error: 'write failed' })
    }
  })
}
