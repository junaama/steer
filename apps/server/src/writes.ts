import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { sql, eq, and } from 'drizzle-orm'
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
} from '@steer/schema'
import type { Db } from './db.js'
import './types.js'

/** Authorization/validation failure surfaced with an HTTP status. */
class WriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const bodySchema = z.object({
  collection: z.enum(['sessions', 'events', 'controls']),
  op: z.enum(['insert', 'update', 'delete']),
  payload: z.record(z.unknown()),
})

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

async function assertOwns(tx: Tx, userId: string, sessionId: string): Promise<void> {
  const rows = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
  if (rows.length === 0) throw new WriteError(403, 'forbidden: not your session')
}

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
        })
        .parse(payload)
      // user_id is injected server-side; any client-supplied user_id is ignored.
      await tx.insert(sessions).values({
        id: p.id,
        userId,
        title: p.title,
        task: p.task ?? null,
        model: p.model ?? 'sonnet',
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
        // Capture the txid INSIDE the same transaction, AFTER the write, so it
        // matches the row's xid in the Electric stream (awaitTxId reconciliation).
        const res = await tx.execute(sql`select pg_current_xact_id()::text as txid`)
        return (res.rows[0] as { txid: string }).txid
      })
      return reply.send({ txid })
    } catch (err) {
      if (err instanceof WriteError) return reply.code(err.status).send({ error: err.message })
      if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid payload', detail: err.flatten() })
      return reply.code(400).send({ error: 'write failed' })
    }
  })
}
