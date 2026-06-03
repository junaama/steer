import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { login, run, watch, whoami, logout, ls, resolveSession, makeSessionId, makeTitle, type Ctx, type IO } from './commands.js'
import { SteerError, type SteerClient, type SessionInput } from './api.js'
import type { SessionState } from './events.js'
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

describe('resolveSession', () => {
  const states: SessionState[] = [
    { id: 'sess-aaa', title: 'Fix checkout', lastStatus: 'completed' },
    { id: 'sess-bbb', title: 'Add auth', lastStatus: 'running' },
    { id: 'sess-ccc', title: 'Add auth', lastStatus: 'error' }, // duplicate title
  ]

  it('matches an exact id', () => {
    expect(resolveSession(states, 'sess-aaa')).toEqual({ id: 'sess-aaa' })
  })
  it('matches a unique exact title', () => {
    expect(resolveSession(states, 'Fix checkout')).toEqual({ id: 'sess-aaa' })
  })
  it('rejects an ambiguous exact title', () => {
    expect(resolveSession(states, 'Add auth')).toMatchObject({ error: expect.stringContaining('Multiple') })
  })
  it('matches a unique partial (case-insensitive)', () => {
    expect(resolveSession(states, 'checkout')).toEqual({ id: 'sess-aaa' })
  })
  it('rejects an ambiguous partial', () => {
    expect(resolveSession(states, 'add')).toMatchObject({ error: expect.stringContaining('matches 2') })
  })
  it('reports no match', () => {
    expect(resolveSession(states, 'nope')).toMatchObject({ error: expect.stringContaining('No session') })
  })
})

describe('run --session (follow-up)', () => {
  const sessionShape = [{ value: { id: 'sess-aaa', title: 'Fix checkout', last_status: 'completed' }, headers: { operation: 'insert' } }]

  it('resolves a session and sends a follow-up message', async () => {
    await saveCredentials(creds, home)
    const client = {
      shape: vi.fn(async () => sessionShape),
      sendMessage: vi.fn(async () => ({ txid: '9' })),
    }
    const { ctx, out } = harness(client)
    expect(await run(ctx, { prompt: 'now add tests', session: 'checkout' })).toBe(0)
    expect(client.sendMessage).toHaveBeenCalledWith('tok', 'sess-aaa', 'now add tests')
    expect(out.join('\n')).toContain('Sent to session sess-aaa')
  })

  it('errors when the session reference does not resolve', async () => {
    await saveCredentials(creds, home)
    const client = { shape: vi.fn(async () => sessionShape), sendMessage: vi.fn() }
    const { ctx, err } = harness(client)
    expect(await run(ctx, { prompt: 'hi', session: 'ghost' })).toBe(1)
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(err.join('\n')).toContain('No session matches')
  })

  it('surfaces a send failure', async () => {
    await saveCredentials(creds, home)
    const client = {
      shape: vi.fn(async () => sessionShape),
      sendMessage: vi.fn(async () => { throw new SteerError(403, 'forbidden') }),
    }
    const { ctx, err } = harness(client)
    expect(await run(ctx, { prompt: 'hi', session: 'sess-aaa' })).toBe(1)
    expect(err.join('\n')).toContain('forbidden')
  })

  it('streams when --watch is set', async () => {
    await saveCredentials(creds, home)
    const client = {
      shape: vi.fn(async (_t: string, coll: 'sessions' | 'events') =>
        coll === 'events'
          ? [{ value: { seq: '0', type: 'message', payload: '{"text":"ok"}' }, headers: { operation: 'insert' } }]
          : [{ value: { id: 'sess-aaa', title: 'Fix checkout', last_status: 'completed' }, headers: { operation: 'insert' } }],
      ),
      sendMessage: vi.fn(async () => ({ txid: '9' })),
    }
    const { ctx, out } = harness(client, { sleep: async () => {} })
    expect(await run(ctx, { prompt: 'go', session: 'sess-aaa', watch: true })).toBe(0)
    expect(out.join('\n')).toContain('[completed]')
  })
})

describe('ls', () => {
  it('errors when not logged in', async () => {
    const { ctx, err } = harness({})
    expect(await ls(ctx)).toBe(1)
    expect(err.join('\n')).toContain('steer login')
  })
  it('reports when there are no sessions', async () => {
    await saveCredentials(creds, home)
    const { ctx, out } = harness({ shape: vi.fn(async () => []) })
    expect(await ls(ctx)).toBe(0)
    expect(out.join('\n')).toContain('No sessions yet')
  })
  it('lists sessions with id, status, and title', async () => {
    await saveCredentials(creds, home)
    const client = {
      shape: vi.fn(async () => [{ value: { id: 'sess-aaa', title: 'Fix checkout', last_status: 'running' }, headers: { operation: 'insert' } }]),
    }
    const { ctx, out } = harness(client)
    expect(await ls(ctx)).toBe(0)
    expect(out.join('\n')).toContain('sess-aaa')
    expect(out.join('\n')).toContain('running')
    expect(out.join('\n')).toContain('Fix checkout')
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
