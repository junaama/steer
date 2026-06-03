import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from './app.js'
import type { Db } from './db.js'
import type { AuthVerifier } from './auth.js'

// CORS lives in an onRequest hook that runs before any route handler, so these
// tests never reach the db — a stub satisfies the type without a Postgres.
const stubDb = {} as unknown as Db
const verifier: AuthVerifier = { verify: async () => null } // rejects everything

const ORIGIN = 'http://localhost:5180'

let app: FastifyInstance

beforeAll(async () => {
  app = buildServer({ db: stubDb, verifier, electricUrl: 'http://electric.test:3000' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('CORS', () => {
  it('answers the POST /writes preflight with 204 + CORS headers, NOT 401', async () => {
    const r = await app.inject({
      method: 'OPTIONS',
      url: '/writes',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    })
    // The whole point: a preflight carries no bearer token, so if it hit the
    // auth gate it would 401 and the real POST would never fire.
    expect(r.statusCode).toBe(204)
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(r.headers['access-control-allow-methods']).toContain('POST')
    expect(r.headers['access-control-allow-headers']).toContain('authorization')
  })

  it('answers the protected /sync preflight without auth (204)', async () => {
    const r = await app.inject({
      method: 'OPTIONS',
      url: '/sync/sessions',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    })
    expect(r.statusCode).toBe(204)
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN)
  })

  it('reflects the Origin and exposes all headers on a normal response', async () => {
    const r = await app.inject({ method: 'GET', url: '/health', headers: { origin: ORIGIN } })
    expect(r.statusCode).toBe(200)
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(r.headers['access-control-expose-headers']).toBe('*')
  })

  it('leaves same-origin / non-browser requests untouched (no Origin → no CORS headers)', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' })
    expect(r.statusCode).toBe(200)
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('still enforces auth on the real request, but makes the 401 CORS-readable', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/writes',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { collection: 'sessions', op: 'insert', payload: { id: 's1', title: 'x' } },
    })
    // Auth is unchanged: no token → 401. But the browser must be able to READ
    // that 401, so the Origin is still reflected.
    expect(r.statusCode).toBe(401)
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN)
  })
})
