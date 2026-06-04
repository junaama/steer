import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { sessions, controls } from '@steer/schema'
import { buildServer } from './app.js'
import { createDb, type Db } from './db.js'
import { createSessionVerifier } from './auth-session.js'

/**
 * PRD behavioral acceptance — the session-management API and the auth boundary,
 * driven end-to-end through real signup -> bearer token -> /writes, with every
 * assertion read back from Postgres (no inferred outputs).
 *
 * Covers: 1a/1b (API + txid sync), 2a (persistence), 4a/4d-ii..v (create, list,
 * interrupt, continue, rename, delete), C2 (request authorization & per-user
 * isolation).
 */
const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://steer:steer@localhost:54321/steer?sslmode=disable'

let pool: pg.Pool
let db: Db
let app: FastifyInstance
let electricCalls: string[] = []

// Fake Electric upstream so the read proxy resolves without a real Electric.
const fakeElectric: typeof fetch = async (input) => {
  electricCalls.push(String(input))
  return new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json', 'electric-handle': 'h1', 'electric-offset': '0_0' },
  })
}

async function signup(email: string, password = 'password123'): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password },
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().token as string
}

function writeAs(
  token: string | null,
  collection: 'sessions' | 'controls' | 'events',
  op: 'insert' | 'update' | 'delete',
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: '/writes',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { collection, op, payload },
  })
}

function whereParam(call: string): string {
  return new URL(call).searchParams.get('where') ?? ''
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  db = createDb(pool)
  await migrate(db, { migrationsFolder: './drizzle' })
  app = buildServer({ db, verifier: createSessionVerifier(db), electricUrl: 'http://electric.test:3000', fetchImpl: fakeElectric })
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE sessions, users CASCADE;')
  electricCalls = []
})

describe('PRD 4d-i / C2: auth boundary', () => {
  it('C2: rejects anonymous writes and syncs (401)', async () => {
    expect((await writeAs(null, 'sessions', 'insert', { id: 's1', title: 'x' })).statusCode).toBe(401)
    const sync = await app.inject({ method: 'GET', url: '/sync/sessions' })
    expect(sync.statusCode).toBe(401)
  })

  it('4d-i: signup issues a bearer token that /auth/me resolves', async () => {
    const token = await signup('alice@steer.dev')
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.email).toBe('alice@steer.dev')
  })
})

describe('PRD 4d-iii / 2a / 1b: create a session', () => {
  it('persists the session, owns it, and starts it (status=starting)', async () => {
    const token = await signup('a@steer.dev')
    const res = await writeAs(token, 'sessions', 'insert', { id: 's1', title: 'Fix bug', task: 'fix the bug', model: 'sonnet' })
    expect(res.statusCode).toBe(200)
    // 1b: the in-transaction txid comes back for optimistic reconciliation.
    expect(String(res.json().txid)).toMatch(/^\d+$/)

    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    expect(row).toBeDefined()
    expect(row!.task).toBe('fix the bug')
    expect(row!.lastStatus).toBe('starting') // 2a persisted; ready for the daemon to pick up
  })

  it('C2: server injects user_id, ignoring any client-supplied owner', async () => {
    const token = await signup('a@steer.dev')
    await writeAs(token, 'sessions', 'insert', { id: 's1', title: 't', userId: 'attacker' })
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
    const myId = me.json().user.id as string
    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    expect(row!.userId).toBe(myId)
    expect(row!.userId).not.toBe('attacker')
  })

  it('§3a: persists the environment routing key when supplied', async () => {
    const token = await signup('a@steer.dev')
    const res = await writeAs(token, 'sessions', 'insert', { id: 's1', title: 't', environment: 'laptop' })
    expect(res.statusCode).toBe(200)
    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    expect(row!.environment).toBe('laptop')
    expect(row!.claimedBy).toBeNull() // claim is daemon-written, never on insert
  })

  it('§3a: leaves the session unrouted (environment=null) when omitted', async () => {
    const token = await signup('a@steer.dev')
    await writeAs(token, 'sessions', 'insert', { id: 's1', title: 't' })
    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    expect(row!.environment).toBeNull()
  })

  it('persists the workdir (the CLI cwd) when supplied, null when omitted', async () => {
    const token = await signup('a@steer.dev')
    await writeAs(token, 'sessions', 'insert', { id: 's1', title: 't', workdir: '/dev/projectA' })
    await writeAs(token, 'sessions', 'insert', { id: 's2', title: 't' })
    const [a] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    const [b] = await db.select().from(sessions).where(eq(sessions.id, 's2'))
    expect(a!.workdir).toBe('/dev/projectA')
    expect(b!.workdir).toBeNull()
  })

  it('C2: ignores a client-supplied claimed_by (daemon-owned field)', async () => {
    const token = await signup('a@steer.dev')
    await writeAs(token, 'sessions', 'insert', { id: 's1', title: 't', claimedBy: 'attacker' })
    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    expect(row!.claimedBy).toBeNull()
  })

  it('rejects an empty environment string (400)', async () => {
    const token = await signup('a@steer.dev')
    const res = await writeAs(token, 'sessions', 'insert', { id: 's1', title: 't', environment: '' })
    expect(res.statusCode).toBe(400)
  })
})

describe('PRD 4d-ii / C2: viewing & scoping the session list', () => {
  it('scopes the sessions sync to the requesting user (where user_id = sub)', async () => {
    const a = await signup('a@steer.dev')
    const b = await signup('b@steer.dev')
    const meA = (await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${a}` } })).json().user.id
    const meB = (await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${b}` } })).json().user.id

    await app.inject({ method: 'GET', url: '/sync/sessions', headers: { authorization: `Bearer ${a}` } })
    const whereA = whereParam(electricCalls.at(-1)!)
    expect(whereA).toContain(meA)
    expect(whereA).not.toContain(meB) // A's stream can never carry B's rows
  })
})

describe('PRD 4d-v: rename / update a session', () => {
  it('updates the title for the owner', async () => {
    const token = await signup('a@steer.dev')
    await writeAs(token, 'sessions', 'insert', { id: 's1', title: 'old' })
    const res = await writeAs(token, 'sessions', 'update', { id: 's1', title: 'renamed' })
    expect(res.statusCode).toBe(200)
    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    expect(row!.title).toBe('renamed')
  })
})

describe('PRD 4d-iv: interrupt & continue', () => {
  it('interrupts via a control row (control-plane-via-data-plane)', async () => {
    const token = await signup('a@steer.dev')
    await writeAs(token, 'sessions', 'insert', { id: 's1', title: 't' })
    await writeAs(token, 'sessions', 'update', { id: 's1', lastStatus: 'running' })
    const res = await writeAs(token, 'controls', 'insert', { sessionId: 's1', type: 'interrupt', payload: {} })
    expect(res.statusCode).toBe(200)
    const rows = await db.select().from(controls).where(eq(controls.sessionId, 's1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('interrupt')
  })

  it('continues an interrupted session by flipping it back to starting', async () => {
    const token = await signup('a@steer.dev')
    await writeAs(token, 'sessions', 'insert', { id: 's1', title: 't' })
    await writeAs(token, 'sessions', 'update', { id: 's1', lastStatus: 'interrupted' })
    await writeAs(token, 'sessions', 'update', { id: 's1', lastStatus: 'starting' })
    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    expect(row!.lastStatus).toBe('starting') // the daemon re-picks it up
  })
})

describe('PRD 4d-iii: delete a session', () => {
  it('deletes the session and cascades its controls', async () => {
    const token = await signup('a@steer.dev')
    await writeAs(token, 'sessions', 'insert', { id: 's1', title: 't' })
    await writeAs(token, 'controls', 'insert', { sessionId: 's1', type: 'interrupt', payload: {} })
    const res = await writeAs(token, 'sessions', 'delete', { id: 's1' })
    expect(res.statusCode).toBe(200)
    expect(await db.select().from(sessions).where(eq(sessions.id, 's1'))).toHaveLength(0)
    expect(await db.select().from(controls).where(eq(controls.sessionId, 's1'))).toHaveLength(0)
  })
})

describe('PRD C2: cross-user authorization', () => {
  it("forbids updating, deleting, or controlling another user's session (403)", async () => {
    const a = await signup('a@steer.dev')
    const b = await signup('b@steer.dev')
    await writeAs(a, 'sessions', 'insert', { id: 's1', title: 'A owns this' })

    expect((await writeAs(b, 'sessions', 'update', { id: 's1', title: 'hijack' })).statusCode).toBe(403)
    expect((await writeAs(b, 'controls', 'insert', { sessionId: 's1', type: 'interrupt', payload: {} })).statusCode).toBe(403)
    expect((await writeAs(b, 'sessions', 'delete', { id: 's1' })).statusCode).toBe(403)

    // A's session is untouched.
    const [row] = await db.select().from(sessions).where(eq(sessions.id, 's1'))
    expect(row!.title).toBe('A owns this')
  })
})
