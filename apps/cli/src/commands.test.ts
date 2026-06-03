import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { login, run, watch, whoami, logout, makeSessionId, makeTitle, type Ctx, type IO } from './commands.js'
import { SteerError, type SteerClient, type SessionInput } from './api.js'
import { saveCredentials, loadCredentials } from './config.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'steer-cmd-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function harness(client: Partial<SteerClient>, extra: Partial<Ctx> = {}) {
  const out: string[] = []
  const err: string[] = []
  const io: IO = {
    print: (s) => out.push(s),
    error: (s) => err.push(s),
    prompt: vi.fn(async () => 'a@b.c'),
    promptHidden: vi.fn(async () => 'password1'),
  }
  const ctx: Ctx = { makeClient: () => client as SteerClient, io, home, ...extra }
  return { ctx, io, out, err }
}

const creds = { serverUrl: 'http://s', token: 'tok', email: 'e@x.y' }

describe('login', () => {
  it('prompts, logs in, and persists credentials', async () => {
    const client = { login: vi.fn(async () => ({ token: 'tok', user: { id: 'u', email: 'a@b.c' } })) }
    const { ctx, io, out } = harness(client)
    expect(await login(ctx, { serverUrl: 'http://s' })).toBe(0)
    expect(io.prompt).toHaveBeenCalled()
    expect(io.promptHidden).toHaveBeenCalled()
    expect(out.join('\n')).toContain('Logged in as a@b.c')
    expect(await loadCredentials(home)).toMatchObject({ token: 'tok', serverUrl: 'http://s' })
  })

  it('uses provided email/password without prompting', async () => {
    const client = { login: vi.fn(async () => ({ token: 't', user: { id: 'u', email: 'x@y.z' } })) }
    const { ctx, io } = harness(client)
    await login(ctx, { serverUrl: 'http://s', email: 'x@y.z', password: 'pw' })
    expect(io.prompt).not.toHaveBeenCalled()
    expect(client.login).toHaveBeenCalledWith('x@y.z', 'pw')
  })

  it('signup flag calls signup', async () => {
    const client = { signup: vi.fn(async () => ({ token: 't', user: { id: 'u', email: 'a@b.c' } })) }
    const { ctx } = harness(client)
    await login(ctx, { serverUrl: 'http://s', email: 'a@b.c', password: 'pw', signup: true })
    expect(client.signup).toHaveBeenCalled()
  })

  it('a 401 on login suggests signup', async () => {
    const client = { login: vi.fn(async () => { throw new SteerError(401, 'bad') }) }
    const { ctx, err } = harness(client)
    expect(await login(ctx, { serverUrl: 'http://s', email: 'a', password: 'b' })).toBe(1)
    expect(err.join('\n')).toContain('steer signup')
  })

  it('a 409 on signup suggests login', async () => {
    const client = { signup: vi.fn(async () => { throw new SteerError(409, 'exists') }) }
    const { ctx, err } = harness(client)
    expect(await login(ctx, { serverUrl: 'http://s', email: 'a', password: 'b', signup: true })).toBe(1)
    expect(err.join('\n')).toContain('steer login')
  })

  it('other SteerErrors print the message', async () => {
    const client = { login: vi.fn(async () => { throw new SteerError(500, 'server down') }) }
    const { ctx, err } = harness(client)
    expect(await login(ctx, { serverUrl: 'http://s', email: 'a', password: 'b' })).toBe(1)
    expect(err.join('\n')).toContain('server down')
  })

  it('non-SteerError failures are caught', async () => {
    const client = { login: vi.fn(async () => { throw new Error('network') }) }
    const { ctx, err } = harness(client)
    expect(await login(ctx, { serverUrl: 'http://s', email: 'a', password: 'b' })).toBe(1)
    expect(err.join('\n')).toContain('network')
  })
})

describe('run', () => {
  it('errors when not logged in', async () => {
    const { ctx, err } = harness({})
    expect(await run(ctx, { prompt: 'do it' })).toBe(1)
    expect(err.join('\n')).toContain('steer login')
  })

  it('errors on an empty prompt', async () => {
    await saveCredentials(creds, home)
    const { ctx, err } = harness({})
    expect(await run(ctx, { prompt: '   ' })).toBe(1)
    expect(err.join('\n')).toContain('Empty prompt')
  })

  it('creates a session and prints the id + watch hint', async () => {
    await saveCredentials(creds, home)
    const client = { createSession: vi.fn(async (_t: string, _i: SessionInput) => ({ txid: '1' })) }
    const { ctx, out } = harness(client)
    expect(await run(ctx, { prompt: 'fix the bug', model: 'opus' })).toBe(0)
    const [token, input] = client.createSession.mock.calls[0]!
    expect(token).toBe('tok')
    expect(input).toMatchObject({ task: 'fix the bug', model: 'opus', title: 'fix the bug' })
    expect(out.join('\n')).toContain('Started session')
    expect(out.join('\n')).toContain('steer watch')
  })

  it('surfaces a SteerError from createSession', async () => {
    await saveCredentials(creds, home)
    const client = { createSession: vi.fn(async () => { throw new SteerError(401, 'unauthorized') }) }
    const { ctx, err } = harness(client)
    expect(await run(ctx, { prompt: 'x' })).toBe(1)
    expect(err.join('\n')).toContain('unauthorized')
  })

  it('surfaces a non-SteerError from createSession', async () => {
    await saveCredentials(creds, home)
    const client = { createSession: vi.fn(async () => { throw new Error('boom') }) }
    const { ctx, err } = harness(client)
    expect(await run(ctx, { prompt: 'x' })).toBe(1)
    expect(err.join('\n')).toContain('boom')
  })

  it('--watch creates then streams to completion (default model)', async () => {
    await saveCredentials(creds, home)
    const client = {
      createSession: vi.fn(async (_t: string, _i: SessionInput) => ({ txid: '1' })),
      shape: vi.fn(async (_t: string, coll: 'sessions' | 'events') => {
        if (coll === 'events') {
          return [{ value: { seq: '0', type: 'message', payload: '{"text":"hi"}' }, headers: { operation: 'insert' } }]
        }
        const id = client.createSession.mock.calls[0]?.[1].id
        return [{ value: { id, title: 'T', last_status: 'completed' }, headers: { operation: 'insert' } }]
      }),
    }
    const { ctx, out } = harness(client, { sleep: async () => {} })
    expect(await run(ctx, { prompt: 'go', watch: true })).toBe(0)
    expect(client.createSession.mock.calls[0]![1].model).toBe('sonnet')
    expect(out.join('\n')).toContain('hi')
    expect(out.join('\n')).toContain('[completed]')
  })
})

describe('watch', () => {
  it('errors when not logged in', async () => {
    const { ctx } = harness({})
    expect(await watch(ctx, { sessionId: 's1' })).toBe(1)
  })

  it('streams new events across polls, then stops on a terminal status (default sleep/now)', async () => {
    await saveCredentials(creds, home)
    let evCall = 0
    const client = {
      shape: vi.fn(async (_t: string, coll: 'sessions' | 'events') => {
        if (coll === 'events') {
          evCall++
          const first = { value: { seq: '0', type: 'thinking', payload: '{"text":"a"}' }, headers: { operation: 'insert' } }
          const second = { value: { seq: '1', type: 'message', payload: '{"text":"done"}' }, headers: { operation: 'insert' } }
          return evCall === 1 ? [first] : [first, second]
        }
        return [{ value: { id: 's1', last_status: evCall < 2 ? 'running' : 'completed' }, headers: { operation: 'insert' } }]
      }),
    }
    const { ctx, out } = harness(client)
    // intervalMs:0 keeps the default setTimeout sleep instant.
    expect(await watch(ctx, { sessionId: 's1', intervalMs: 0 })).toBe(0)
    expect(out.join('\n')).toContain('done')
    expect(out.join('\n')).toContain('[completed]')
  })

  it('stops on timeout when the session never terminates', async () => {
    await saveCredentials(creds, home)
    const client = { shape: vi.fn(async () => []) } // no events, session not found → never terminal
    let t = 0
    const { ctx, out } = harness(client, { sleep: async () => {}, now: () => (t += 1000) })
    expect(await watch(ctx, { sessionId: 's1', maxMs: 0, intervalMs: 1 })).toBe(0)
    expect(out.join('\n')).toContain('timed out')
  })
})

describe('whoami', () => {
  it('errors when not logged in', async () => {
    const { ctx, err } = harness({})
    expect(await whoami(ctx)).toBe(1)
    expect(err.join('\n')).toContain('steer login')
  })

  it('prints the account', async () => {
    await saveCredentials(creds, home)
    const client = { me: vi.fn(async () => ({ user: { id: 'u', email: 'a@b.c' } })) }
    const { ctx, out } = harness(client)
    expect(await whoami(ctx)).toBe(0)
    expect(out.join('\n')).toContain('a@b.c')
  })

  it('reports an expired session', async () => {
    await saveCredentials(creds, home)
    const client = { me: vi.fn(async () => { throw new SteerError(401, 'unauthorized') }) }
    const { ctx, err } = harness(client)
    expect(await whoami(ctx)).toBe(1)
    expect(err.join('\n')).toContain('steer login')
  })
})

describe('logout', () => {
  it('invalidates server-side and clears the local token', async () => {
    await saveCredentials(creds, home)
    const client = { logout: vi.fn(async () => {}) }
    const { ctx } = harness(client)
    expect(await logout(ctx)).toBe(0)
    expect(client.logout).toHaveBeenCalledWith('tok')
    expect(await loadCredentials(home)).toBeNull()
  })

  it('still clears locally when the server call fails', async () => {
    await saveCredentials(creds, home)
    const client = { logout: vi.fn(async () => { throw new Error('offline') }) }
    const { ctx } = harness(client)
    expect(await logout(ctx)).toBe(0)
    expect(await loadCredentials(home)).toBeNull()
  })

  it('is a no-op when not logged in', async () => {
    const { ctx } = harness({})
    expect(await logout(ctx)).toBe(0)
  })
})

describe('helpers', () => {
  it('makeSessionId is unique and prefixed', () => {
    expect(makeSessionId()).toMatch(/^sess-/)
    expect(makeSessionId()).not.toBe(makeSessionId())
  })

  it('makeTitle keeps short prompts and truncates long ones', () => {
    expect(makeTitle('short')).toBe('short')
    const long = makeTitle('x'.repeat(60))
    expect(long).toHaveLength(41)
    expect(long.endsWith('…')).toBe(true)
  })
})
