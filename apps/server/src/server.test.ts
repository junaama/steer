import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { FastifyInstance } from 'fastify'
import { MAX_IMAGE_BASE64_BYTES } from '@steer/schema'
import { buildServer } from './app.js'
import { createDb } from './db.js'
import type { AuthVerifier } from './auth.js'
import { ensureDefaultTestDatabase, testDatabaseUrl } from './test-db.js'

const TEST_URL = testDatabaseUrl()

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
  await ensureDefaultTestDatabase()
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

  it('renames and deletes a session the user owns', async () => {
    await insertSession('tokenA', 's1', 'Original')
    const upd = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'sessions', op: 'update', payload: { id: 's1', title: 'Renamed', model: 'opus' } },
    })
    expect(upd.statusCode).toBe(200)
    const row = await pool.query('select title, last_status, model from sessions where id=$1', ['s1'])
    expect(row.rows[0]).toMatchObject({ title: 'Renamed', last_status: 'starting', model: 'opus' })

    const del = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'sessions', op: 'delete', payload: { id: 's1' } },
    })
    expect(del.statusCode).toBe(200)
    expect((await pool.query('select 1 from sessions where id=$1', ['s1'])).rowCount).toBe(0)
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

  it('rejects client-owned status changes and event writes', async () => {
    await insertSession('tokenA', 's1')
    const status = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: {
        collection: 'sessions',
        op: 'update',
        payload: { id: 's1', lastStatus: 'completed' },
      },
    })
    expect(status.statusCode).toBe(400)
    const persisted = await pool.query('select last_status from sessions where id=$1', ['s1'])
    expect(persisted.rows[0].last_status).toBe('starting')

    const eventInsert = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: {
        collection: 'events',
        op: 'insert',
        payload: { sessionId: 's1', seq: 0, type: 'message', payload: { text: 'forged' } },
      },
    })
    expect(eventInsert.statusCode).toBe(400)
    const events = await pool.query('select 1 from events where session_id=$1', ['s1'])
    expect(events.rowCount).toBe(0)

    const ctlUpd = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'controls', op: 'update', payload: { sessionId: 's1', type: 'interrupt', payload: {} } },
    })
    expect(ctlUpd.statusCode).toBe(400)
  })

  it('rejects an invalid session payload (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'sessions', op: 'insert', payload: { id: 's1' } }, // missing title
    })
    expect(r.statusCode).toBe(400)
  })

  it('rejects a malformed request body (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'widgets', op: 'insert', payload: {} },
    })
    expect(r.statusCode).toBe(400)
  })

  it('surfaces an unexpected write failure (duplicate id) as 400', async () => {
    await insertSession('tokenA', 'dup', 'first')
    const r = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'sessions', op: 'insert', payload: { id: 'dup', title: 'again' } },
    })
    expect(r.statusCode).toBe(400)
  })

  // R14 vision input: an optional image rides the initial task. The write boundary
  // validates the `image/*` rule + size cap (shared schema) and persists it to the
  // `task_image` jsonb column that Electric syncs out to the daemon.
  it('persists an attached image on session create (R14)', async () => {
    const image = { mediaType: 'image/png', dataBase64: 'iVBORw0KGgo' }
    const r = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'sessions', op: 'insert', payload: { id: 's-img', title: 'fix layout', task: 'see screenshot', image } },
    })
    expect(r.statusCode).toBe(200)
    const rows = await pool.query('select task_image from sessions where id=$1', ['s-img'])
    expect(rows.rows[0].task_image).toEqual(image)
  })

  it('rejects an over-cap image at the write boundary (400)', async () => {
    // 1 byte past the cap (the constant lives in @steer/schema; this stays in lockstep).
    const overCap = 'a'.repeat(MAX_IMAGE_BASE64_BYTES + 1)
    const r = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'sessions', op: 'insert', payload: { id: 's-big', title: 't', image: { mediaType: 'image/png', dataBase64: overCap } } },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid payload')
    // The session was NOT created (rejected before insert).
    const rows = await pool.query('select id from sessions where id=$1', ['s-big'])
    expect(rows.rows).toHaveLength(0)
  })

  it('rejects a non-image media type at the write boundary (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: auth('tokenA'),
      payload: { collection: 'sessions', op: 'insert', payload: { id: 's-pdf', title: 't', image: { mediaType: 'application/pdf', dataBase64: 'JVBERi0=' } } },
    })
    expect(r.statusCode).toBe(400)
    const rows = await pool.query('select id from sessions where id=$1', ['s-pdf'])
    expect(rows.rows).toHaveLength(0)
  })

  it('leaves task_image null when no image is attached (existing flow unchanged)', async () => {
    await insertSession('tokenA', 's-plain', 'plain task')
    const rows = await pool.query('select task_image from sessions where id=$1', ['s-plain'])
    expect(rows.rows[0].task_image).toBeNull()
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

  it('allows an empty events shape while an optimistic session insert is reconciling', async () => {
    const r = await app.inject({ method: 'GET', url: '/sync/events?session_id=s-new', headers: auth('tokenA') })
    expect(r.statusCode).toBe(200)
    expect(shapeParam(electricCalls.at(-1) ?? '', 'table')).toBe('events')
    expect(shapeParam(electricCalls.at(-1) ?? '', 'where')).toBe("session_id = 's-new'")
  })

  it('404s an unknown collection and 400s events without a session_id', async () => {
    expect((await app.inject({ method: 'GET', url: '/sync/widgets', headers: auth('tokenA') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/sync/events', headers: auth('tokenA') })).statusCode).toBe(400)
  })

  it('scopes the controls shape and passes through the offset cursor', async () => {
    await insertSession('tokenA', 's1')
    const forbidden = await app.inject({ method: 'GET', url: '/sync/controls?session_id=s1', headers: auth('tokenB') })
    expect(forbidden.statusCode).toBe(403)
    const r = await app.inject({ method: 'GET', url: '/sync/controls?session_id=s1&offset=42', headers: auth('tokenA') })
    expect(r.statusCode).toBe(200)
    expect(shapeParam(electricCalls.at(-1) ?? '', 'table')).toBe('controls')
    expect(shapeParam(electricCalls.at(-1) ?? '', 'offset')).toBe('42')
  })

  it('allows an empty controls shape while an optimistic session insert is reconciling', async () => {
    const r = await app.inject({ method: 'GET', url: '/sync/controls?session_id=s-new', headers: auth('tokenA') })
    expect(r.statusCode).toBe(200)
    expect(shapeParam(electricCalls.at(-1) ?? '', 'table')).toBe('controls')
    expect(shapeParam(electricCalls.at(-1) ?? '', 'where')).toBe("session_id = 's-new'")
  })

  it('proxies the environments shape with WHERE 1 = 1 and Vary: Authorization', async () => {
    const r = await app.inject({ method: 'GET', url: '/sync/environments', headers: auth('tokenA') })
    expect(r.statusCode).toBe(200)
    expect(r.headers['vary']).toBe('Authorization')
    expect(shapeParam(electricCalls.at(-1) ?? '', 'table')).toBe('environments')
    expect(shapeParam(electricCalls.at(-1) ?? '', 'where')).toBe('1 = 1')
  })
})
