import { randomUUID } from 'node:crypto'
import { SteerClient, SteerError } from './api.js'
import { saveCredentials, loadCredentials, clearCredentials } from './config.js'
import { decodeEvents, decodeSessions, formatEvent, isTerminal, type SessionState } from './events.js'

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
  /** Target an existing session (by id or name) instead of creating a new one. */
  session?: string
}

/** Resolve a `--session` argument to exactly one session id, or an error message. */
export function resolveSession(states: SessionState[], arg: string): { id: string } | { error: string } {
  const byId = states.find((s) => s.id === arg)
  if (byId) return { id: byId.id }
  const exact = states.filter((s) => s.title === arg)
  if (exact.length === 1) return { id: exact[0]!.id }
  if (exact.length > 1) return { error: `Multiple sessions are named "${arg}" — use the id (steer ls).` }
  const q = arg.toLowerCase()
  const partial = states.filter((s) => s.title.toLowerCase().includes(q))
  if (partial.length === 1) return { id: partial[0]!.id }
  if (partial.length > 1) return { error: `"${arg}" matches ${partial.length} sessions — be more specific or use the id.` }
  return { error: `No session matches "${arg}". Try: steer ls` }
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

  // Follow-up: send the prompt to an existing session instead of creating one.
  if (opts.session) {
    const states = decodeSessions(await client.shape(creds.token, 'sessions'))
    const resolved = resolveSession(states, opts.session)
    if ('error' in resolved) {
      ctx.io.error(resolved.error)
      return 1
    }
    try {
      await client.sendMessage(creds.token, resolved.id, opts.prompt)
    } catch (err) {
      ctx.io.error(`Could not send message: ${err instanceof SteerError ? err.message : String(err)}`)
      return 1
    }
    ctx.io.print(`Sent to session ${resolved.id} — the daemon will resume it.`)
    if (!opts.watch) {
      ctx.io.print(`Watch it: steer watch ${resolved.id}`)
      return 0
    }
    return watch(ctx, { sessionId: resolved.id })
  }

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

export async function ls(ctx: Ctx): Promise<number> {
  const creds = await loadCredentials(ctx.home)
  if (!creds) {
    ctx.io.error('Not logged in. Run: steer login')
    return 1
  }
  const states = decodeSessions(await ctx.makeClient(creds.serverUrl).shape(creds.token, 'sessions'))
  if (states.length === 0) {
    ctx.io.print('No sessions yet. Start one: steer "<prompt>"')
    return 0
  }
  for (const s of states) ctx.io.print(`${s.id}  [${s.lastStatus}]  ${s.title}`)
  return 0
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
    // The two shapes are independent reads — fetch them concurrently each tick.
    const [rawEvents, rawSessions] = await Promise.all([
      client.shape(creds.token, 'events', opts.sessionId),
      client.shape(creds.token, 'sessions'),
    ])
    for (const e of decodeEvents(rawEvents)) {
      if (e.seq > lastSeq) {
        ctx.io.print(formatEvent(e))
        lastSeq = e.seq
      }
    }
    const me = decodeSessions(rawSessions).find((s) => s.id === opts.sessionId)
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
