import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { sessions, events } from '@steer/schema'
import { createDb, type Db } from './db.js'
import { seedDemo } from './seed-demo.js'

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://steer:steer@localhost:54321/steer?sslmode=disable'

let pool: pg.Pool
let db: Db

async function sessionCount(userId: string): Promise<number> {
  const r = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))
  return r.length
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  db = createDb(pool)
  await migrate(db, { migrationsFolder: './drizzle' })
})
afterAll(async () => {
  await pool.end()
})
beforeEach(async () => {
  await pool.query('TRUNCATE sessions CASCADE;')
})

describe('seedDemo', () => {
  it('creates the demo sessions and the finished session trace', async () => {
    await seedDemo(db, 'u1')
    expect(await sessionCount('u1')).toBe(2)
    const evs = await db.select().from(events).where(eq(events.sessionId, 'seed-u1-fix-checkout'))
    expect(evs).toHaveLength(4)
    const starting = await db.select().from(sessions).where(eq(sessions.id, 'seed-u1-add-auth'))
    expect(starting[0]?.lastStatus).toBe('starting')
    expect(starting[0]?.task).toContain('login()')
  })

  it('is idempotent — re-seeding the same user does not duplicate', async () => {
    await seedDemo(db, 'u1')
    await seedDemo(db, 'u1')
    expect(await sessionCount('u1')).toBe(2)
    const evs = await db.select().from(events).where(eq(events.sessionId, 'seed-u1-fix-checkout'))
    expect(evs).toHaveLength(4)
  })

  it('namespaces by user so different users never collide', async () => {
    await seedDemo(db, 'u1')
    await seedDemo(db, 'u2')
    expect(await sessionCount('u1')).toBe(2)
    expect(await sessionCount('u2')).toBe(2)
  })
})
