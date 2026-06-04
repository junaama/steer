import { describe, expect, it } from 'vitest'
import { decideRestore, type AuthUser } from './restore'

const USER: AuthUser = { id: 'u1', email: 'reviewer@steer.dev' }

describe('decideRestore', () => {
  it('signs the user in on a 200 with a user body', () => {
    expect(decideRestore({ ok: true, status: 200, user: USER })).toEqual({
      kind: 'authed',
      user: USER,
    })
  })

  it('clears the token on a 401 (token expired/revoked)', () => {
    expect(decideRestore({ ok: true, status: 401, user: null })).toEqual({ kind: 'clear' })
  })

  it('clears the token on a 403 (token rejected)', () => {
    expect(decideRestore({ ok: true, status: 403, user: null })).toEqual({ kind: 'clear' })
  })

  it('keeps the token on a network error — a restarting server must not log the user out', () => {
    // This is the regression: `docker compose up` recreates the server, the
    // /auth/me probe fails to connect, and the token must survive.
    expect(decideRestore({ ok: false })).toEqual({ kind: 'keep' })
  })

  it('keeps the token on a 5xx (server up but unhealthy)', () => {
    expect(decideRestore({ ok: true, status: 503, user: null })).toEqual({ kind: 'keep' })
    expect(decideRestore({ ok: true, status: 502, user: null })).toEqual({ kind: 'keep' })
  })

  it('keeps the token on a reached-but-inconclusive 200 with no user body', () => {
    expect(decideRestore({ ok: true, status: 200, user: null })).toEqual({ kind: 'keep' })
  })
})
