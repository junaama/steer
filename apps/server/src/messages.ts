import type { FastifyInstance } from 'fastify'
import { sql, eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { sessions, events, parseEventPayload } from '@steer/schema'
import type { Db } from './db.js'
import { ownsSession, captureTxid, WriteError } from './session-tx.js'
import './types.js'

const bodySchema = z.object({ text: z.string().min(1) })

/**
 * Append a follow-up user message to an existing session and re-queue it.
 *
 * The new turn is a `user_message` event the agent projects into the model
 * context; flipping the session back to `starting` makes the daemon resume it.
 * `seq` is computed inside the transaction (like the agent's appendEvent) so it
 * stays monotonic without a client-side read-modify-write race.
 */
export function registerMessages(app: FastifyInstance, db: Db): void {
  app.post('/sessions/:id/continue', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const txid = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ lastStatus: sessions.lastStatus })
          .from(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.userId, req.userId)))
        if (!row) throw new WriteError(403, 'forbidden: not your session')
        if (row.lastStatus !== 'interrupted') throw new WriteError(409, 'session is not interrupted')
        await tx.update(sessions).set({ lastStatus: 'starting', updatedAt: new Date() }).where(eq(sessions.id, id))
        return captureTxid(tx)
      })
      return reply.send({ txid })
    } catch (err) {
      if (err instanceof WriteError) return reply.code(err.status).send({ error: err.message })
      throw err
    }
  })

  app.post('/sessions/:id/message', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'text is required' })
    if (!(await ownsSession(db, req.userId, id)))
      return reply.code(403).send({ error: 'forbidden: not your session' })

    const payload = parseEventPayload('user_message', { text: parsed.data.text })
    const txid = await db.transaction(async (tx) => {
      const res = await tx.execute(
        sql`select coalesce(max(seq), -1) + 1 as next from ${events} where session_id = ${id}`,
      )
      const next = Number((res.rows[0] as { next: number | string }).next)
      await tx.insert(events).values({ sessionId: id, seq: next, type: 'user_message', payload })
      await tx.update(sessions).set({ lastStatus: 'starting', updatedAt: new Date() }).where(eq(sessions.id, id))
      return captureTxid(tx)
    })
    return reply.send({ txid })
  })
}
