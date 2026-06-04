export type FetchLike = typeof fetch

export interface AuthResult {
  token: string
  user: { id: string; email: string }
}

export interface SessionInput {
  id: string
  title: string
  task?: string
  model?: string
  /** Route the session to a named environment (the daemon that owns those files). */
  environment?: string
  /** The directory the session should run in — the cwd the CLI was launched from. */
  workdir?: string
}

/** An error carrying the server's HTTP status so commands can react (e.g. 409 → "already registered"). */
export class SteerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SteerError'
  }
}

export interface ClientOptions {
  serverUrl: string
  fetchImpl?: FetchLike
}

/**
 * Thin typed client over the same HTTP surface the web app uses: `/auth/*` for
 * tokens, `/writes` for session creation, `/sync/*` for the Electric read path.
 * The CLI never touches Postgres directly — it goes through the server like any
 * other client, so auth and ownership scoping are enforced server-side.
 */
export class SteerClient {
  private readonly fetchImpl: FetchLike

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async request<T>(path: string, init: RequestInit, token?: string): Promise<T> {
    const headers = new Headers(init.headers)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    if (token) headers.set('authorization', `Bearer ${token}`)
    const res = await this.fetchImpl(`${this.opts.serverUrl}${path}`, { ...init, headers })
    const text = await res.text()
    if (!res.ok) throw new SteerError(res.status, extractError(text) ?? `request failed (${res.status})`)
    return (text ? JSON.parse(text) : undefined) as T
  }

  signup(email: string, password: string): Promise<AuthResult> {
    return this.request<AuthResult>('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) })
  }

  login(email: string, password: string): Promise<AuthResult> {
    return this.request<AuthResult>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  }

  async logout(token: string): Promise<void> {
    await this.request<void>('/auth/logout', { method: 'POST' }, token)
  }

  me(token: string): Promise<{ user: { id: string; email: string } }> {
    return this.request<{ user: { id: string; email: string } }>('/auth/me', { method: 'GET' }, token)
  }

  createSession(token: string, input: SessionInput): Promise<{ txid: string }> {
    // `environment` is omitted from the wire when undefined (JSON drops it), so an
    // unrouted session sends exactly the same payload as before.
    const payload = {
      id: input.id,
      title: input.title,
      task: input.task,
      model: input.model,
      environment: input.environment,
      workdir: input.workdir,
    }
    return this.request<{ txid: string }>(
      '/writes',
      { method: 'POST', body: JSON.stringify({ collection: 'sessions', op: 'insert', payload }) },
      token,
    )
  }

  /** Append a follow-up turn to an existing session and re-queue it. */
  sendMessage(token: string, sessionId: string, text: string): Promise<{ txid: string }> {
    return this.request<{ txid: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/message`,
      { method: 'POST', body: JSON.stringify({ text }) },
      token,
    )
  }

  /**
   * Read an Electric shape to its current state. Electric serves a shape as a
   * log: the first request (offset=-1, applied by the proxy) returns only the
   * initial snapshot, terminated by a `snapshot-end` control with an
   * `electric-offset` header but *no* `electric-up-to-date`. A conformant reader
   * must keep requesting from the returned offset+handle until Electric reports
   * up-to-date; otherwise it sees a frozen snapshot and misses every later
   * insert / rename / status change (the web app's TanStack DB client does this,
   * and the CLI must too). Returns the concatenated log for events.ts to fold.
   */
  async shape(token: string, collection: 'sessions' | 'events', sessionId?: string): Promise<unknown[]> {
    const base = `/sync/${collection}${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`
    const sep = base.includes('?') ? '&' : '?'
    const messages: unknown[] = []
    let cursor: { offset: string; handle: string } | null = null
    for (;;) {
      const path = cursor
        ? `${base}${sep}offset=${encodeURIComponent(cursor.offset)}&handle=${encodeURIComponent(cursor.handle)}`
        : base
      const { rows, headers } = await this.getShape(path, token)
      messages.push(...rows)
      // up-to-date header => caught up with Electric; stop the (non-live) drain.
      if (headers.get('electric-up-to-date') !== null) break
      const offset = headers.get('electric-offset')
      const handle = headers.get('electric-handle')
      // No cursor to advance from (a degenerate response) — return what we have.
      if (offset === null || handle === null) break
      cursor = { offset, handle }
    }
    return messages
  }

  /** One shape request, exposing the Electric cursor headers the drain needs. */
  private async getShape(path: string, token: string): Promise<{ rows: unknown[]; headers: Headers }> {
    const res = await this.fetchImpl(`${this.opts.serverUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const text = await res.text()
    if (!res.ok) throw new SteerError(res.status, extractError(text) ?? `request failed (${res.status})`)
    return { rows: JSON.parse(text) as unknown[], headers: res.headers }
  }
}

function extractError(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: string }
    return body.error ?? null
  } catch {
    return text || null
  }
}
