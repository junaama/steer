import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { FastifyInstance } from 'fastify'
import { buildServer } from './app.js'
import { createDb } from './db.js'
import type { AuthVerifier } from './auth.js'

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://steer:steer@localhost:54321/steer?sslmode=disable'

const verifier: AuthVerifier = {
  verify: async (token) => {
    if (token === 'tokenA') return { sub: 'userA' }
    if (token === 'tokenB') return { sub: 'userB' }
    return null
  },
}

let pool: pg.Pool
let app: FastifyInstance
let electricCalls: string[] = []

const fakeElectric: typeof fetch = async (input) => {
  electricCalls.push(String(input))
  return new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json', 'electric-handle': 'h1', 'electric-offset': '0_0' },
  })
}

function auth(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

// URLSearchParams encodes spaces as '+'; .get() decodes them back correctly.
function shapeParam(call: string, key: string): string {
  return new URL(call).searchParams.get(key) ?? ''
}

async function insertSession(token: string, id: string, title = 'Session'): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/writes',
    headers: auth(token),
    payload: { collection: 'sessions', op: 'insert', payload: { id, title } },
  })
  expect(r.statusCode).toBe(200)
  return r.json().txid as string
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  const db = createDb(pool)
  await migrate(db, { migrationsFolder: './drizzle' })
  app = buildServer({
    db,
    verifier,
    electricUrl: 'http://electric.test:3000',
    fetchImpl: fakeElectric,
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE sessions CASCADE;')
  electricCalls = []
})

describe('POST /writes', () => {
  it('rejects writes without a valid token (401)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/writes',
      payload: { collection: 'sessions', op: 'insert', payload: { id: 's1', title: 't' } },
    })
    expect(r.statusCode).toBe(401)
  })

  it('injects user_id from the token and ignores a client-supplied user_id', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'sessions', op: 'insert', payload: { id: 's1', title: 'Add auth', userId: 'HACK' } },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().txid).toMatch(/^\d+$/)
    const rows = await pool.query('select user_id from sessions where id=$1', ['s1'])
    expect(rows.rows[0].user_id).toBe('userA')
  })

  it('returns a txid that increases across writes (matches the row xid)', async () => {
    const t1 = await insertSession('tokenA', 's1')
    const t2 = await insertSession('tokenA', 's2')
    expect(BigInt(t2)).toBeGreaterThan(BigInt(t1))
  })

  it('forbids cross-user update and delete (403), leaving the row intact', async () => {
    await insertSession('tokenA', 's1')
    const upd = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenB'),
      payload: { collection: 'sessions', op: 'update', payload: { id: 's1', title: 'hijack' } },
    })
    expect(upd.statusCode).toBe(403)
    const del = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenB'),
      payload: { collection: 'sessions', op: 'delete', payload: { id: 's1' } },
    })
    expect(del.statusCode).toBe(403)
    const rows = await pool.query('select 1 from sessions where id=$1', ['s1'])
    expect(rows.rowCount).toBe(1)
  })

  it('validates control payloads — override to a side-effecting tool is rejected', async () => {
    await insertSession('tokenA', 's1')
    const bad = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: {
        collection: 'controls',
        op: 'insert',
        payload: { sessionId: 's1', type: 'override', payload: { toolCallId: 'tc1', newTool: 'write_file' } },
      },
    })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: {
        collection: 'controls',
        op: 'insert',
        payload: { sessionId: 's1', type: 'override', payload: { toolCallId: 'tc1', newTool: 'read_file' } },
      },
    })
    expect(ok.statusCode).toBe(200)
  })
})

describe('Electric proxy', () => {
  it('rejects unauthenticated shape requests (401)', async () => {
    const r = await app.inject({ method: 'GET', url: '/sync/sessions' })
    expect(r.statusCode).toBe(401)
  })

  it('injects where user_id=<sub> for the sessions shape and sets Vary: Authorization', async () => {
    const r = await app.inject({ method: 'GET', url: '/sync/sessions', headers: auth('tokenA') })
    expect(r.statusCode).toBe(200)
    expect(r.headers['vary']).toBe('Authorization')
    expect(shapeParam(electricCalls[0] ?? '', 'table')).toBe('sessions')
    expect(shapeParam(electricCalls[0] ?? '', 'where')).toBe("user_id = 'userA'")
  })

  it('scopes the events shape to an owned session and forbids non-owners (403)', async () => {
    await insertSession('tokenA', 's1')
    const forbidden = await app.inject({ method: 'GET', url: '/sync/events?session_id=s1', headers: auth('tokenB') })
    expect(forbidden.statusCode).toBe(403)
    const ok = await app.inject({ method: 'GET', url: '/sync/events?session_id=s1', headers: auth('tokenA') })
    expect(ok.statusCode).toBe(200)
    expect(shapeParam(electricCalls.at(-1) ?? '', 'where')).toBe("session_id = 's1'")
  })
})
