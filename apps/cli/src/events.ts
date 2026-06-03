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

/** Decode the sessions shape into states (used to detect when a run finishes). */
export function decodeSessions(items: unknown[]): SessionState[] {
  const out: SessionState[] = []
  for (const item of items) {
    const row = item as ShapeRow
    if (!row.value || !row.headers?.operation) continue
    const v = row.value
    out.push({
      id: String(v.id ?? ''),
      title: String(v.title ?? ''),
      lastStatus: String(v.last_status ?? v.lastStatus ?? ''),
    })
  }
  return out
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
