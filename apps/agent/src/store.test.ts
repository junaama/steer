import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { sessions } from '@steer/schema'
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
