import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { FastifyInstance } from 'fastify'
import { buildServer } from './app.js'
import { createDb } from './db.js'
import { createSessionVerifier } from './auth-session.js'
import { ensureDefaultTestDatabase, testDatabaseUrl } from './test-db.js'

const TEST_URL = testDatabaseUrl()

const fakeElectric: typeof fetch = async () =>
  new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json', 'electric-handle': 'h1', 'electric-offset': '0_0' },
  })

let pool: pg.Pool
let app: FastifyInstance

const CREDS = { email: 'alice@example.com', password: 'supersecret123' }

async function signup(creds = CREDS): Promise<{ token: string; user: { id: string; email: string } }> {
  const r = await app.inject({ method: 'POST', url: '/auth/signup', payload: creds })
  expect(r.statusCode).toBe(201)
  return r.json()
}

beforeAll(async () => {
  await ensureDefaultTestDatabase()
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  const db = createDb(pool)
  await migrate(db, { migrationsFolder: './drizzle' })
  app = buildServer({ db, verifier: createSessionVerifier(db), electricUrl: 'http://electric.test:3000', fetchImpl: fakeElectric })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await pool.end()
})
beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE; TRUNCATE sessions CASCADE;')
})

describe('POST /auth/signup', () => {
  it('creates an account and returns a token + user', async () => {
    const { token, user } = await signup()
    expect(token).toBeTruthy()
    expect(user.email).toBe(CREDS.email)
    expect(user.id).toBeTruthy()
  })

  it('lowercases the email and rejects a duplicate (409)', async () => {
    await signup()
    const dup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'ALICE@example.com', password: 'anotherpass123' },
    })
    expect(dup.statusCode).toBe(409)
  })

  it('rejects an invalid email or short password (400)', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: 'nope', password: 'supersecret123' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: 'b@x.io', password: 'short' } })).statusCode).toBe(400)
  })
})

describe('POST /auth/login', () => {
  it('logs in with correct credentials', async () => {
    await signup()
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: CREDS })
    expect(r.statusCode).toBe(200)
    expect(r.json().token).toBeTruthy()
  })

  it('rejects a wrong password, an unknown email, and a malformed body (401)', async () => {
    await signup()
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: CREDS.email, password: 'wrongwrong123' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ghost@example.com', password: 'whatever123' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'x' } })).statusCode).toBe(401)
  })
})

describe('GET /auth/me', () => {
  it('returns the current user for a valid token', async () => {
    const { token, user } = await signup()
    const r = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
    expect(r.statusCode).toBe(200)
    expect(r.json().user).toEqual(user)
  })

  it('401s without a token or with a bogus one', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Bearer bogus' } })).statusCode).toBe(401)
  })
})

describe('POST /auth/logout', () => {
  it('invalidates the session so the token no longer authenticates', async () => {
    const { token } = await signup()
    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } })
    expect(out.statusCode).toBe(204)
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.statusCode).toBe(401)
  })

  it('is a no-op (204) when no token is supplied', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(204)
  })
})

describe('end-to-end: a signed-up user can write and is scoped on sync', () => {
  it('writes a session owned by the token subject and scopes the sync shape to it', async () => {
    const { token, user } = await signup()
    const auth = { authorization: `Bearer ${token}` }

    const write = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth,
      payload: { collection: 'sessions', op: 'insert', payload: { id: 's1', title: 'Add auth', userId: 'HACK' } },
    })
    expect(write.statusCode).toBe(200)
    const row = await pool.query('select user_id from sessions where id=$1', ['s1'])
    expect(row.rows[0].user_id).toBe(user.id)

    const sync = await app.inject({ method: 'GET', url: '/sync/sessions', headers: auth })
    expect(sync.statusCode).toBe(200)
    expect(sync.headers['vary']).toBe('Authorization')
  })
})
