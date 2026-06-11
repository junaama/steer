import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq, asc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { sessions, events } from '@steer/schema'
import { buildServer } from './app.js'
import { createDb, type Db } from './db.js'
import { createSessionVerifier } from './auth-session.js'
import { ensureDefaultTestDatabase, testDatabaseUrl } from './test-db.js'

const TEST_URL = testDatabaseUrl()

let pool: pg.Pool
let db: Db
let app: FastifyInstance

const noElectric: typeof fetch = async () => new Response('[]', { status: 200 })

async function signup(email: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password: 'password123' } })
  expect(r.statusCode).toBe(201)
  return r.json().token as string
}

async function createSession(token: string, id: string): Promise<void> {
  const r = await app.inject({
    method: 'POST',
    url: '/writes',
    headers: { authorization: `Bearer ${token}` },
    payload: { collection: 'sessions', op: 'insert', payload: { id, title: 't', task: 'do the thing' } },
  })
  expect(r.statusCode).toBe(200)
}

function sendMessage(token: string | null, id: string, text: unknown) {
  return app.inject({
    method: 'POST',
    url: `/sessions/${id}/message`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { text },
  })
}

beforeAll(async () => {
  await ensureDefaultTestDatabase()
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  db = createDb(pool)
  await migrate(db, { migrationsFolder: './drizzle' })
  app = buildServer({ db, verifier: createSessionVerifier(db), electricUrl: 'http://electric.test:3000', fetchImpl: noElectric })
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE sessions, users CASCADE;')
})

describe('POST /sessions/:id/message — follow-up turns', () => {
  it('appends a user_message event and re-queues the session (status=starting)', async () => {
    const token = await signup('a@steer.dev')
    await createSession(token, 's1')
    await db.update(sessions).set({ lastStatus: 'completed' }).where(eq(sessions.id, 's1'))

    const res = await sendMessage(token, 's1', 'now add tests')
    expect(res.statusCode).toBe(200)
    expect(String(res.json().txid)).toMatch(/^\d+$/)

    const evs = await db.select().from(events).where(eq(events.sessionId, 's1')).orderBy(asc(events.seq))
    const last = evs.at(-1)!
    expect(last.type).toBe('user_message')
    expect((last.payload as { text: string }).text).toBe('now add tests')

    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    expect(row!.lastStatus).toBe('starting') // resumed for the daemon
  })

  it('assigns monotonic seq across successive messages', async () => {
    const token = await signup('a@steer.dev')
    await createSession(token, 's1')
    await sendMessage(token, 's1', 'first')
    await sendMessage(token, 's1', 'second')
    const evs = await db.select().from(events).where(eq(events.sessionId, 's1')).orderBy(asc(events.seq))
    expect(evs.map((e) => e.seq)).toEqual([0, 1])
  })

  it('rejects an empty message (400)', async () => {
    const token = await signup('a@steer.dev')
    await createSession(token, 's1')
    expect((await sendMessage(token, 's1', '')).statusCode).toBe(400)
  })

  it('requires authentication (401)', async () => {
    expect((await sendMessage(null, 's1', 'hi')).statusCode).toBe(401)
  })

  it("forbids messaging another user's session (403)", async () => {
    const a = await signup('a@steer.dev')
    const b = await signup('b@steer.dev')
    await createSession(a, 's1')
    expect((await sendMessage(b, 's1', 'sneaky')).statusCode).toBe(403)
    // unknown session id is also 403 (no ownership row)
    expect((await sendMessage(a, 'nope', 'hi')).statusCode).toBe(403)
  })
})
