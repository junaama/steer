import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, resolveServerUrl, usage, dispatch, VERSION } from './cli.js'
import type { Ctx, IO } from './commands.js'
import type { SteerClient } from './api.js'

describe('parseArgs', () => {
  it('treats a bare argument as a run prompt', () => {
    expect(parseArgs(['fix the bug'])).toMatchObject({ command: 'run', prompt: 'fix the bug' })
    expect(parseArgs(['fix', 'the', 'bug'])).toMatchObject({ command: 'run', prompt: 'fix the bug' })
  })

  it('recognizes the explicit run command', () => {
    expect(parseArgs(['run', 'do', 'thing'])).toMatchObject({ command: 'run', prompt: 'do thing' })
  })

  it('recognizes subcommands', () => {
    expect(parseArgs(['login']).command).toBe('login')
    expect(parseArgs(['signup']).command).toBe('signup')
    expect(parseArgs(['logout']).command).toBe('logout')
    expect(parseArgs(['whoami']).command).toBe('whoami')
  })

  it('parses watch with and without an id', () => {
    expect(parseArgs(['watch', 'sess-1'])).toMatchObject({ command: 'watch', sessionId: 'sess-1' })
    expect(parseArgs(['watch'])).toMatchObject({ command: 'watch', sessionId: '' })
  })

  it('defaults to help with no args', () => {
    expect(parseArgs([]).command).toBe('help')
  })

  it('honors help/version flags', () => {
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['-h']).command).toBe('help')
    expect(parseArgs(['--version']).command).toBe('version')
    expect(parseArgs(['-v']).command).toBe('version')
  })

  it('parses value flags in space and equals form', () => {
    const a = parseArgs(['login', '--server', 'http://x', '--email', 'e@x', '--password', 'pw', '--model', 'opus'])
    expect(a.flags).toMatchObject({ serverUrl: 'http://x', email: 'e@x', password: 'pw', model: 'opus' })
    const b = parseArgs(['run', 'go', '--server=http://y', '--model=haiku'])
    expect(b.flags).toMatchObject({ serverUrl: 'http://y', model: 'haiku' })
    expect(b.prompt).toBe('go')
  })

  it('parses boolean flags', () => {
    expect(parseArgs(['do it', '--watch'])).toMatchObject({ command: 'run', prompt: 'do it', flags: { watch: true } })
    expect(parseArgs(['login', '--signup']).flags.signup).toBe(true)
  })

  it('parses --env in space and equals form', () => {
    expect(parseArgs(['go', '--env', 'laptop']).flags.env).toBe('laptop')
    expect(parseArgs(['go', '--env=docker']).flags.env).toBe('docker')
  })

  it('parses --session for follow-ups and the ls command', () => {
    expect(parseArgs(['add tests', '--session', 'sess-1'])).toMatchObject({
      command: 'run',
      prompt: 'add tests',
      flags: { session: 'sess-1' },
    })
    expect(parseArgs(['ls']).command).toBe('ls')
  })

  it('ignores a trailing value-flag with no value and unknown flags', () => {
    expect(parseArgs(['login', '--server']).flags.serverUrl).toBeUndefined()
    expect(parseArgs(['--unknown', 'prompt'])).toMatchObject({ command: 'run', prompt: 'prompt' })
  })
})

describe('resolveServerUrl', () => {
  it('prefers flag, then env, then the localhost default', () => {
    expect(resolveServerUrl({ serverUrl: 'http://flag' }, {})).toBe('http://flag')
    expect(resolveServerUrl({}, { STEER_SERVER_URL: 'http://env' })).toBe('http://env')
    expect(resolveServerUrl({}, {})).toBe('http://localhost:8080')
  })
})

describe('usage', () => {
  it('documents the core commands', () => {
    expect(usage()).toContain('steer login')
    expect(usage()).toContain('steer "<prompt>"')
  })
})

describe('dispatch', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'steer-cli-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function harness(client: Partial<SteerClient>) {
    const out: string[] = []
    const err: string[] = []
    const io: IO = { print: (s) => out.push(s), error: (s) => err.push(s), prompt: async () => '', promptHidden: async () => '' }
    const ctx: Ctx = { makeClient: () => client as SteerClient, io, home }
    return { ctx, out, err }
  }

  it('routes help and version', async () => {
    const a = harness({})
    expect(await dispatch(parseArgs(['help']), a.ctx, {})).toBe(0)
    expect(a.out.join('\n')).toContain('Usage:')
    const b = harness({})
    await dispatch(parseArgs(['version']), b.ctx, {})
    expect(b.out.join('\n')).toBe(VERSION)
  })

  it('routes login using env-supplied credentials', async () => {
    const client = { login: vi.fn(async () => ({ token: 't', user: { id: 'u', email: 'a@b.c' } })) }
    const { ctx } = harness(client)
    expect(await dispatch(parseArgs(['login']), ctx, { STEER_EMAIL: 'a@b.c', STEER_PASSWORD: 'pw' })).toBe(0)
    expect(client.login).toHaveBeenCalledWith('a@b.c', 'pw')
  })

  it('routes signup', async () => {
    const client = { signup: vi.fn(async () => ({ token: 't', user: { id: 'u', email: 'a@b.c' } })) }
    const { ctx } = harness(client)
    await dispatch(parseArgs(['signup', '--email', 'a@b.c', '--password', 'pw']), ctx, {})
    expect(client.signup).toHaveBeenCalled()
  })

  it('routes a bare prompt to run (which requires login)', async () => {
    const { ctx, err } = harness({})
    expect(await dispatch(parseArgs(['just do it']), ctx, {})).toBe(1)
    expect(err.join('\n')).toContain('steer login')
  })

  it('rejects watch without a session id', async () => {
    const { ctx, err } = harness({})
    expect(await dispatch(parseArgs(['watch']), ctx, {})).toBe(1)
    expect(err.join('\n')).toContain('watch <session-id>')
  })

  it('routes watch with an id', async () => {
    const { ctx } = harness({})
    expect(await dispatch(parseArgs(['watch', 's1']), ctx, {})).toBe(1) // not logged in → 1
  })

  it('routes whoami and logout', async () => {
    const { ctx } = harness({})
    expect(await dispatch(parseArgs(['whoami']), ctx, {})).toBe(1)
    expect(await dispatch(parseArgs(['logout']), ctx, {})).toBe(0)
  })

  it('routes ls and a --session follow-up', async () => {
    const lsClient = { shape: vi.fn(async () => []) }
    const a = harness(lsClient)
    expect(await dispatch(parseArgs(['ls']), a.ctx, {})).toBe(1) // not logged in → 1
    const b = harness({})
    // --session run also requires login here, so it returns 1 — but it routes to run.
    expect(await dispatch(parseArgs(['hello', '--session', 'sess-1']), b.ctx, {})).toBe(1)
    expect(b.err.join('\n')).toContain('steer login')
  })
})
