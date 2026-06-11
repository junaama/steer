import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { users, authSessions } from '@steer/schema'
import { createDb, type Db } from './db.js'
import {
  generateSessionToken,
  sessionIdFromToken,
  createSession,
  validateSessionToken,
  invalidateSession,
  createSessionVerifier,
} from './auth-session.js'
import { ensureDefaultTestDatabase, testDatabaseUrl } from './test-db.js'

const TEST_URL = testDatabaseUrl()

const DAY_MS = 24 * 60 * 60 * 1000
const USER_ID = 'user-1'

let pool: pg.Pool
let db: Db

async function expiresAt(token: string): Promise<Date> {
  const rows = await db
    .select({ expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .where(eq(authSessions.id, sessionIdFromToken(token)))
  return rows[0]!.expiresAt
}

beforeAll(async () => {
  await ensureDefaultTestDatabase()
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  db = createDb(pool)
  await migrate(db, { migrationsFolder: './drizzle' })
})
afterAll(async () => {
  await pool.end()
})
beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE;')
  await db.insert(users).values({ id: USER_ID, email: 'u1@example.com', passwordHash: 'x' })
})

describe('session tokens', () => {
  it('generates distinct high-entropy tokens and a deterministic sha-256 id', () => {
    const a = generateSessionToken()
    const b = generateSessionToken()
    expect(a).not.toBe(b)
    expect(sessionIdFromToken(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(sessionIdFromToken(a)).toBe(sessionIdFromToken(a))
    // The persisted id is the hash, never the token itself.
    expect(sessionIdFromToken(a)).not.toBe(a)
  })

  it('validates a live session to its user', async () => {
    const token = generateSessionToken()
    await createSession(db, token, USER_ID)
    expect(await validateSessionToken(db, token)).toEqual({ id: USER_ID, email: 'u1@example.com' })
  })

  it('returns null for an unknown token', async () => {
    expect(await validateSessionToken(db, generateSessionToken())).toBeNull()
  })

  it('rejects and deletes an expired session', async () => {
    const token = generateSessionToken()
    // Issued 31 days ago → already past its 30-day TTL.
    await createSession(db, token, USER_ID, new Date(Date.now() - 31 * DAY_MS))
    expect(await validateSessionToken(db, token)).toBeNull()
    const rows = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.id, sessionIdFromToken(token)))
    expect(rows).toHaveLength(0)
  })

  it('slides the expiry forward when inside the renewal window', async () => {
    const token = generateSessionToken()
    // Issued 20 days ago → expires in ~10 days, inside the 15-day renew window.
    await createSession(db, token, USER_ID, new Date(Date.now() - 20 * DAY_MS))
    const before = await expiresAt(token)
    expect(await validateSessionToken(db, token)).not.toBeNull()
    const after = await expiresAt(token)
    expect(after.getTime()).toBeGreaterThan(before.getTime())
  })

  it('does not slide a freshly-issued session', async () => {
    const token = generateSessionToken()
    await createSession(db, token, USER_ID)
    const before = await expiresAt(token)
    await validateSessionToken(db, token)
    expect((await expiresAt(token)).getTime()).toBe(before.getTime())
  })

  it('invalidates a session on logout', async () => {
    const token = generateSessionToken()
    await createSession(db, token, USER_ID)
    await invalidateSession(db, token)
    expect(await validateSessionToken(db, token)).toBeNull()
  })
})

describe('createSessionVerifier', () => {
  it('resolves a valid token to its subject and rejects an invalid one', async () => {
    const verifier = createSessionVerifier(db)
    const token = generateSessionToken()
    await createSession(db, token, USER_ID)
    expect(await verifier.verify(token)).toEqual({ sub: USER_ID })
    expect(await verifier.verify('garbage')).toBeNull()
  })
})
