import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { sessions, environments } from '@steer/schema'
import { createDb, type Db } from './db.js'
import { createDbStore, type AgentStore } from './store.js'

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://steer:steer@localhost:54321/steer?sslmode=disable'

let pool: pg.Pool
let db: Db
let store: AgentStore

async function newSession(environment: string | null = null): Promise<string> {
  const id = randomUUID()
  await db.insert(sessions).values({ id, userId: 'u1', title: 't', lastStatus: 'starting', environment })
  return id
}

async function claimedBy(id: string): Promise<string | null> {
  const r = await db.select({ c: sessions.claimedBy }).from(sessions).where(eq(sessions.id, id))
  return r[0]!.c
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  db = createDb(pool)
  await migrate(db, { migrationsFolder: '../server/drizzle' })
  store = createDbStore(db)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE sessions CASCADE;')
  await pool.query('TRUNCATE environments CASCADE;')
})

describe('appendEvent (streaming delta event types)', () => {
  it('accepts a valid message_delta and persists it', async () => {
    const id = await newSession()
    const seq = await store.appendEvent(id, 'message_delta', { text: 'Hel' })
    expect(seq).toBe(0)
    const events = await store.listEvents(id)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('message_delta')
    expect(events[0]!.payload).toEqual({ text: 'Hel' })
  })

  it('accepts a valid thinking_delta and persists it', async () => {
    const id = await newSession()
    await store.appendEvent(id, 'thinking_delta', { text: 'weighing options' })
    const events = await store.listEvents(id)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('thinking_delta')
    expect(events[0]!.payload).toEqual({ text: 'weighing options' })
  })

  it('rejects a message_delta missing text (zod throws, nothing persists)', async () => {
    const id = await newSession()
    await expect(store.appendEvent(id, 'message_delta', {})).rejects.toThrow()
    const events = await store.listEvents(id)
    expect(events).toHaveLength(0)
  })

  it('increments seq atomically across delta and terminal event types', async () => {
    const id = await newSession()
    expect(await store.appendEvent(id, 'thinking_delta', { text: 'plan' })).toBe(0)
    expect(await store.appendEvent(id, 'message_delta', { text: 'Hel' })).toBe(1)
    expect(await store.appendEvent(id, 'message_delta', { text: 'lo' })).toBe(2)
    expect(await store.appendEvent(id, 'message', { text: 'Hello' })).toBe(3)

    const events = await store.listEvents(id)
    expect(events.map((e) => e.type)).toEqual(['thinking_delta', 'message_delta', 'message_delta', 'message'])
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
  })
})

describe('claimSession (single-owner atomic claim)', () => {
  it('claims an unclaimed session and records the owner', async () => {
    const id = await newSession()
    expect(await store.claimSession(id, 'laptop')).toBe(true)
    expect(await claimedBy(id)).toBe('laptop')
  })

  it('lets only one of two competing owners win (the other never runs it)', async () => {
    const id = await newSession()
    expect(await store.claimSession(id, 'ownerA')).toBe(true)
    expect(await store.claimSession(id, 'ownerB')).toBe(false)
    expect(await claimedBy(id)).toBe('ownerA') // loser cannot steal the binding
  })

  it('is idempotent for the owning daemon (re-queue / crash-resume re-claim)', async () => {
    const id = await newSession()
    expect(await store.claimSession(id, 'laptop')).toBe(true)
    expect(await store.claimSession(id, 'laptop')).toBe(true)
    expect(await claimedBy(id)).toBe('laptop')
  })

  it('returns false when no session matches the id', async () => {
    expect(await store.claimSession('does-not-exist', 'laptop')).toBe(false)
  })
})

describe('upsertEnvironment', () => {
  it('inserts a new environment row', async () => {
    await store.upsertEnvironment('laptop', 'laptop', 'host1.local')
    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.id, 'laptop'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.env).toBe('laptop')
    expect(rows[0]!.host).toBe('host1.local')
    expect(rows[0]!.lastSeenAt).toBeInstanceOf(Date)
    expect(rows[0]!.createdAt).toBeInstanceOf(Date)
  })

  it('inserts a default daemon with env=null', async () => {
    await store.upsertEnvironment('myhost', null, 'myhost')
    const rows = await db
      .select()
      .from(environments)
      .where(eq(environments.id, 'myhost'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.env).toBeNull()
    expect(rows[0]!.host).toBe('myhost')
  })

  it('is idempotent: re-upsert updates host and last_seen_at', async () => {
    await store.upsertEnvironment('laptop', 'laptop', 'host1.local')
    const before = await db
      .select()
      .from(environments)
      .where(eq(environments.id, 'laptop'))
    const firstSeen = before[0]!.lastSeenAt

    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 20))
    await store.upsertEnvironment('laptop', 'laptop', 'host2.local')

    const after = await db
      .select()
      .from(environments)
      .where(eq(environments.id, 'laptop'))
    expect(after).toHaveLength(1)
    expect(after[0]!.host).toBe('host2.local')
    expect(after[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(firstSeen.getTime())
  })
})

describe('heartbeat', () => {
  it('advances last_seen_at for a registered environment', async () => {
    await store.upsertEnvironment('laptop', 'laptop', 'host1.local')
    const before = await db
      .select({ lastSeenAt: environments.lastSeenAt })
      .from(environments)
      .where(eq(environments.id, 'laptop'))
    const firstSeen = before[0]!.lastSeenAt

    await new Promise((r) => setTimeout(r, 20))
    await store.heartbeat('laptop')

    const after = await db
      .select({ lastSeenAt: environments.lastSeenAt })
      .from(environments)
      .where(eq(environments.id, 'laptop'))
    expect(after[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(firstSeen.getTime())
  })

  it('is a no-op for a non-existent environment (no error)', async () => {
    // heartbeat on a missing id should not throw
    await expect(store.heartbeat('does-not-exist')).resolves.toBeUndefined()
  })
})
