import { randomUUID } from 'node:crypto'
import { SteerClient, SteerError } from './api.js'
import { saveCredentials, loadCredentials, clearCredentials } from './config.js'
import { decodeEvents, decodeSessions, formatEvent, isTerminal } from './events.js'

/** Terminal I/O, injected so commands are testable without a real TTY. */
export interface IO {
  print(s: string): void
  error(s: string): void
  prompt(label: string): Promise<string>
  promptHidden(label: string): Promise<string>
}

export interface Ctx {
  makeClient: (serverUrl: string) => SteerClient
  io: IO
  home?: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export function makeSessionId(): string {
  return `sess-${randomUUID()}`
}

export function makeTitle(prompt: string): string {
  const trimmed = prompt.trim()
  return trimmed.length > 42 ? `${trimmed.slice(0, 40).trim()}…` : trimmed
}

export interface LoginOpts {
  serverUrl: string
  email?: string
  password?: string
  signup?: boolean
}

export async function login(ctx: Ctx, opts: LoginOpts): Promise<number> {
  const email = opts.email ?? (await ctx.io.prompt('Email: '))
  const password = opts.password ?? (await ctx.io.promptHidden('Password: '))
  const client = ctx.makeClient(opts.serverUrl)
  try {
    const res = opts.signup ? await client.signup(email, password) : await client.login(email, password)
    await saveCredentials({ serverUrl: opts.serverUrl, token: res.token, email: res.user.email }, ctx.home)
    ctx.io.print(`Logged in as ${res.user.email} → ${opts.serverUrl}`)
    return 0
  } catch (err) {
    if (err instanceof SteerError) {
      if (!opts.signup && err.status === 401) ctx.io.error('Invalid email or password. New here? run: steer signup')
      else if (opts.signup && err.status === 409) ctx.io.error('That email is already registered. run: steer login')
      else ctx.io.error(`Login failed: ${err.message}`)
      return 1
    }
    ctx.io.error(`Login failed: ${String(err)}`)
    return 1
  }
}

export interface RunOpts {
  prompt: string
  model?: string
  watch?: boolean
}

export async function run(ctx: Ctx, opts: RunOpts): Promise<number> {
  const creds = await loadCredentials(ctx.home)
  if (!creds) {
    ctx.io.error('Not logged in. Run: steer login')
    return 1
  }
  if (!opts.prompt.trim()) {
    ctx.io.error('Empty prompt. Usage: steer "<what the agent should do>"')
    return 1
  }
  const client = ctx.makeClient(creds.serverUrl)
  const id = makeSessionId()
  try {
    await client.createSession(creds.token, {
      id,
      title: makeTitle(opts.prompt),
      task: opts.prompt,
      model: opts.model ?? 'sonnet',
    })
  } catch (err) {
    const msg = err instanceof SteerError ? err.message : String(err)
    ctx.io.error(`Could not start session: ${msg}`)
    return 1
  }
  ctx.io.print(`Started session ${id} — the daemon will pick it up within ~1.5s.`)
  if (!opts.watch) {
    ctx.io.print(`Watch it: steer watch ${id}`)
    return 0
  }
  return watch(ctx, { sessionId: id })
}

export interface WatchOpts {
  sessionId: string
  intervalMs?: number
  maxMs?: number
}

export async function watch(ctx: Ctx, opts: WatchOpts): Promise<number> {
  const creds = await loadCredentials(ctx.home)
  if (!creds) {
    ctx.io.error('Not logged in. Run: steer login')
    return 1
  }
  const client = ctx.makeClient(creds.serverUrl)
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = ctx.now ?? (() => Date.now())
  const deadline = now() + (opts.maxMs ?? 300_000)
  let lastSeq = -1
  for (;;) {
    const events = decodeEvents(await client.shape(creds.token, 'events', opts.sessionId))
    for (const e of events) {
      if (e.seq > lastSeq) {
        ctx.io.print(formatEvent(e))
        lastSeq = e.seq
      }
    }
    const me = decodeSessions(await client.shape(creds.token, 'sessions')).find((s) => s.id === opts.sessionId)
    if (me && isTerminal(me.lastStatus)) {
      ctx.io.print(`\n[${me.lastStatus}]`)
      return 0
    }
    if (now() >= deadline) {
      ctx.io.print('\n[watch timed out — the session keeps running on the daemon]')
      return 0
    }
    await sleep(opts.intervalMs ?? 1000)
  }
}

export async function whoami(ctx: Ctx): Promise<number> {
  const creds = await loadCredentials(ctx.home)
  if (!creds) {
    ctx.io.error('Not logged in. Run: steer login')
    return 1
  }
  try {
    const { user } = await ctx.makeClient(creds.serverUrl).me(creds.token)
    ctx.io.print(`${user.email} → ${creds.serverUrl}`)
    return 0
  } catch {
    ctx.io.error('Session expired. Run: steer login')
    return 1
  }
}

export async function logout(ctx: Ctx): Promise<number> {
  const creds = await loadCredentials(ctx.home)
  if (creds) {
    try {
      await ctx.makeClient(creds.serverUrl).logout(creds.token)
    } catch {
      // Best-effort server-side invalidation; always clear the local token below.
    }
  }
  await clearCredentials(ctx.home)
  ctx.io.print('Logged out.')
  return 0
}
