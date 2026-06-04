import { sql, eq, and, or, isNull, asc } from 'drizzle-orm'
import {
  events,
  controls,
  sessions,
  environments,
  parseEventPayload,
  type EventType,
  type ControlType,
  type SessionStatus,
} from '@steer/schema'
import type { Db } from './db.js'

export interface StoredEvent {
  sessionId: string
  seq: number
  type: EventType
  payload: unknown
}

export interface StoredControl {
  id: string
  type: ControlType
  payload: unknown
}

/**
 * The agent is a trusted server-side writer, so it appends events directly to
 * Postgres (Electric streams them to the UI). Every append validates its payload
 * against the schema, keeping the event log clean and correct.
 */
export interface AgentStore {
  listEvents(sessionId: string): Promise<StoredEvent[]>
  appendEvent(sessionId: string, type: EventType, payload: unknown): Promise<number>
  setStatus(sessionId: string, status: SessionStatus): Promise<void>
  listUnconsumedControls(sessionId: string): Promise<StoredControl[]>
  consumeControl(id: string): Promise<void>
  /**
   * Atomically claim a session for this daemon (single-owner). Returns true iff
   * this daemon now owns it — the claim succeeds only when the row is unclaimed
   * or already claimed by the same `owner` (idempotent for re-queue/crash-resume,
   * so a follow-up turn resumes on the same environment). A different daemon's
   * claim returns false, so two daemons never run the same session.
   */
  claimSession(sessionId: string, owner: string): Promise<boolean>
  /**
   * Register (or re-register) this daemon in the environments table. Idempotent:
   * ON CONFLICT (id) updates env, host, and last_seen_at.
   */
  upsertEnvironment(id: string, env: string | null, host: string): Promise<void>
  /** Advance `last_seen_at` for a registered environment (heartbeat). */
  heartbeat(id: string): Promise<void>
}

export function createDbStore(db: Db): AgentStore {
  return {
    async listEvents(sessionId) {
      const rows = await db
        .select({ sessionId: events.sessionId, seq: events.seq, type: events.type, payload: events.payload })
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .orderBy(asc(events.seq))
      return rows as StoredEvent[]
    },

    async appendEvent(sessionId, type, payload) {
      const validated = parseEventPayload(type, payload)
      return db.transaction(async (tx) => {
        const res = await tx.execute(
          sql`select coalesce(max(seq), -1) + 1 as next from ${events} where session_id = ${sessionId}`,
        )
        const next = Number((res.rows[0] as { next: number | string }).next)
        await tx.insert(events).values({ sessionId, seq: next, type, payload: validated })
        return next
      })
    },

    async setStatus(sessionId, status) {
      await db
        .update(sessions)
        .set({ lastStatus: status, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId))
    },

    async listUnconsumedControls(sessionId) {
      const rows = await db
        .select({ id: controls.id, type: controls.type, payload: controls.payload })
        .from(controls)
        .where(and(eq(controls.sessionId, sessionId), isNull(controls.consumedAt)))
        .orderBy(asc(controls.createdAt))
      return rows as StoredControl[]
    },

    async consumeControl(id) {
      await db.update(controls).set({ consumedAt: new Date() }).where(eq(controls.id, id))
    },

    async claimSession(sessionId, owner) {
      // Compare-and-set: take the row only if unclaimed or already mine. Postgres
      // makes the conditional UPDATE atomic, so concurrent daemons can't both win.
      const won = await db
        .update(sessions)
        .set({ claimedBy: owner })
        .where(
          and(eq(sessions.id, sessionId), or(isNull(sessions.claimedBy), eq(sessions.claimedBy, owner))),
        )
        .returning({ id: sessions.id })
      return won.length > 0
    },

    async upsertEnvironment(id, env, host) {
      await db
        .insert(environments)
        .values({ id, env, host })
        .onConflictDoUpdate({
          target: environments.id,
          set: { env, host, lastSeenAt: new Date() },
        })
    },

    async heartbeat(id) {
      await db
        .update(environments)
        .set({ lastSeenAt: new Date() })
        .where(eq(environments.id, id))
    },
  }
}
