import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import type { Message } from '@electric-sql/client'
import { sessions, type SessionStatus } from '@steer/schema'
import { createDb, type Db } from './db.js'
import { createDbStore, type AgentStore } from './store.js'
import { runnableFromMessages } from './intake.js'
import { ensureDefaultTestDatabase, testDatabaseUrl } from './test-db.js'

/**
 * Run-anywhere end-to-end (U8): proves session→environment routing + single-owner
 * claiming + queue-until-connect + follow-up affinity against a REAL Postgres.
 * Every assertion reads the claim back from the DB (no inferred outputs).
 *
 * One "daemon" here = (routing env, stable owner). `intake()` reproduces the live
 * chain: read the synced sessions, project to the rows routed to this daemon
 * (`runnableFromMessages`), then atomically claim each (`store.claimSession`). The
 * ids it returns are exactly the sessions this daemon would run. The createRunner
 * gate that turns a won claim into a run is unit-tested in daemon.test.ts.
 */

const TEST_URL = testDatabaseUrl()

let pool: pg.Pool
let db: Db
let store: AgentStore

async function seed(id: string, environment: string | null, status: SessionStatus = 'starting'): Promise<void> {
  await db.insert(sessions).values({ id, userId: 'u1', title: id, lastStatus: status, environment })
}

function change(value: Record<string, unknown>): Message {
  return { key: `sessions/${String(value.id)}`, value, headers: { operation: 'update' } } as unknown as Message
}

async function claimedBy(id: string): Promise<string | null> {
  const r = await db.select({ c: sessions.claimedBy }).from(sessions).where(eq(sessions.id, id))
  return r[0]?.c ?? null
}
async function statusOf(id: string): Promise<string> {
  const r = await db.select({ s: sessions.lastStatus }).from(sessions).where(eq(sessions.id, id))
  return r[0]!.s
}
async function requeue(id: string): Promise<void> {
  await db.update(sessions).set({ lastStatus: 'starting' }).where(eq(sessions.id, id))
}

/** One intake+claim pass for a daemon. Returns the session ids it would run. */
async function intake(env: string | null, owner: string): Promise<string[]> {
  const rows = await db.select().from(sessions)
  const msgs = rows.map((r) => change({ id: r.id, last_status: r.lastStatus, environment: r.environment }))
  const claimed: string[] = []
  for (const intent of runnableFromMessages(msgs, env)) {
    if (await store.claimSession(intent.id, owner)) claimed.push(intent.id)
  }
  return claimed
}

beforeAll(async () => {
  await ensureDefaultTestDatabase()
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
})

describe('run-anywhere: routing + claim', () => {
  it('each daemon runs only the sessions routed to its environment', async () => {
    await seed('on-laptop', 'laptop')
    await seed('on-docker', 'docker')
    await seed('unrouted', null)

    expect(await intake('laptop', 'laptop')).toEqual(['on-laptop'])
    expect(await intake(null, 'box-1')).toEqual(['unrouted'])

    // The laptop session ran on the laptop env; the docker session never ran
    // (no docker daemon connected) — it stays queued, unclaimed.
    expect(await claimedBy('on-laptop')).toBe('laptop')
    expect(await claimedBy('unrouted')).toBe('box-1')
    expect(await claimedBy('on-docker')).toBeNull()
  })
})

describe('run-anywhere: single-owner across daemons', () => {
  it('two default daemons race for an unrouted session — exactly one wins', async () => {
    await seed('shared', null)
    const first = await intake(null, 'box-A')
    const second = await intake(null, 'box-B')
    expect(first).toEqual(['shared'])
    expect(second).toEqual([]) // box-B sees it (routing) but loses the claim
    expect(await claimedBy('shared')).toBe('box-A')
  })
})

describe('run-anywhere: queue until the environment connects', () => {
  it('a session for an offline environment waits, then runs when its daemon starts', async () => {
    await seed('pending-on-ci', 'ci')

    // No CI daemon yet — neither the default nor another env claims it.
    expect(await intake(null, 'box-1')).toEqual([])
    expect(await intake('laptop', 'laptop')).toEqual([])
    expect(await claimedBy('pending-on-ci')).toBeNull()
    expect(await statusOf('pending-on-ci')).toBe('starting') // still queued

    // The CI daemon connects → it claims and runs it.
    expect(await intake('ci', 'ci')).toEqual(['pending-on-ci'])
    expect(await claimedBy('pending-on-ci')).toBe('ci')
  })
})

describe('run-anywhere: follow-up resumes on the same environment', () => {
  it('a re-queued session is re-claimed only by its owning environment', async () => {
    await seed('feature-x', 'laptop')
    expect(await intake('laptop', 'laptop')).toEqual(['feature-x'])

    // A follow-up turn re-queues it (messages.ts flips status → starting).
    await requeue('feature-x')

    // A daemon in a different environment must NOT pick it up...
    expect(await intake('docker', 'docker')).toEqual([])
    // ...and the laptop daemon re-claims it idempotently (same owner).
    expect(await intake('laptop', 'laptop')).toEqual(['feature-x'])
    expect(await claimedBy('feature-x')).toBe('laptop') // affinity held throughout
  })
})
