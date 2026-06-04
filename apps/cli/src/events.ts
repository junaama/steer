export interface AgentEvent {
  seq: number
  type: string
  payload: Record<string, unknown>
}

export interface SessionState {
  id: string
  title: string
  lastStatus: string
}

const TERMINAL_STATUSES = new Set(['completed', 'interrupted', 'error'])

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

function parsePayload(p: unknown): Record<string, unknown> {
  if (p !== null && typeof p === 'object') return p as Record<string, unknown>
  if (typeof p === 'string') {
    try {
      const parsed: unknown = JSON.parse(p)
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

interface ShapeRow {
  value?: Record<string, unknown>
  headers?: { operation?: string; control?: string }
}

/**
 * Decode an Electric shape array (the raw `/sync/events` body) into ordered
 * events. Electric streams snake_case columns, jsonb as a JSON string, and
 * interleaves control rows (snapshot markers) with no `operation` — those are
 * skipped.
 */
export function decodeEvents(items: unknown[]): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const item of items) {
    const row = item as ShapeRow
    if (!row.value || !row.headers?.operation) continue
    out.push({
      seq: Number(row.value.seq ?? 0),
      type: String(row.value.type ?? ''),
      payload: parsePayload(row.value.payload),
    })
  }
  return out.sort((a, b) => a.seq - b.seq)
}

/**
 * Decode the sessions shape into current state. Electric serves a shape as an
 * ordered op-log: an `insert` carries the full row, an `update` only the changed
 * columns (plus the id), a `delete` only the id. Fold the log by id — merging
 * partial updates so a status-only update doesn't blank the title (and a rename
 * doesn't blank the status), and dropping deleted rows. Callers must pass the
 * *fully drained* shape (see SteerClient.shape) or this reflects a stale prefix.
 */
export function decodeSessions(items: unknown[]): SessionState[] {
  const byId = new Map<string, SessionState>()
  for (const item of items) {
    const row = item as ShapeRow
    const op = row.headers?.operation
    if (!row.value || !op) continue
    const v = row.value
    const id = String(v.id ?? '')
    if (op === 'delete') {
      byId.delete(id)
      continue
    }
    const prev = byId.get(id) ?? { id, title: '', lastStatus: '' }
    const status = v.last_status ?? v.lastStatus
    byId.set(id, {
      id,
      title: v.title !== undefined ? String(v.title) : prev.title,
      lastStatus: status !== undefined ? String(status) : prev.lastStatus,
    })
  }
  return [...byId.values()]
}

function truncate(s: string, n = 200): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine
}

function compactArgs(args: unknown): string {
  if (args === null || typeof args !== 'object') return ''
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${truncate(String(v), 40)}`)
    .join(', ')
}

/** Render one event as a single terminal line (ASCII only, no color deps). */
export function formatEvent(e: AgentEvent): string {
  const p = e.payload
  switch (e.type) {
    case 'thinking':
      return `  · ${truncate(String(p.text ?? ''))}`
    case 'message':
      return `\n${String(p.text ?? '')}\n`
    case 'tool_proposed':
      return `  -> ${String(p.name ?? '?')}(${compactArgs(p.args)})`
    case 'tool_result':
      return `  ok ${String(p.name ?? '?')}: ${truncate(String(p.result ?? ''))}`
    case 'tool_substituted':
      return `  ~> ${String(p.from ?? '?')} replaced by ${String(p.name ?? '?')}: ${truncate(String(p.result ?? ''))}`
    case 'tool_cancelled':
      return `  x ${String(p.name ?? '?')} (${String(p.reason ?? 'cancelled')})`
    case 'interrupted':
      return `  || interrupted`
    default:
      return `  ${e.type}`
  }
}
