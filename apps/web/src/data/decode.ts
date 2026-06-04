import type { SessionStatus, EventType } from '@steer/schema'
import type { SessionRow, EventRow, EnvironmentRow } from './types.js'

type Raw = Record<string, unknown>

/**
 * Decode rows as they arrive from Electric into the app's strict row types.
 *
 * Electric streams the raw Postgres shape: snake_case column names
 * (`last_status`, `updated_at`, …), integers as strings (`seq: "0"`), and jsonb
 * as a JSON string (`payload: "{...}"`). Optimistic local inserts, by contrast,
 * are already camelCase objects. We read camel first, snake second (`?? `), so a
 * single decoder normalizes both an optimistic row and the authoritative synced
 * row that later replaces it.
 */
function val(raw: Raw, camel: string, snake: string): unknown {
  return raw[camel] ?? raw[snake]
}

/** jsonb arrives as a JSON string from Electric, or an object from an optimistic row. */
function asPayload(p: unknown): Record<string, unknown> {
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

export function decodeSessionRow(raw: Raw): SessionRow {
  const status = val(raw, 'lastStatus', 'last_status')
  return {
    id: String(raw.id ?? ''),
    userId: String(val(raw, 'userId', 'user_id') ?? ''),
    title: String(raw.title ?? ''),
    task: (raw.task as string | null | undefined) ?? null,
    // Default rather than emit undefined — an unmapped status must never reach a
    // bare `META[status]` lookup (that was the `reading 'color'` crash).
    lastStatus: (typeof status === 'string' ? status : 'idle') as SessionStatus,
    model: String(raw.model ?? 'sonnet'),
    // `environment` is one word in both wire formats; null when unrouted/absent.
    environment: (raw.environment as string | null | undefined) ?? null,
    createdAt: String(val(raw, 'createdAt', 'created_at') ?? ''),
    updatedAt: String(val(raw, 'updatedAt', 'updated_at') ?? ''),
  }
}

export function decodeEventRow(raw: Raw): EventRow {
  return {
    sessionId: String(val(raw, 'sessionId', 'session_id') ?? ''),
    seq: Number(raw.seq ?? 0),
    type: raw.type as EventType,
    payload: asPayload(raw.payload),
  }
}

export function decodeEnvironmentRow(raw: Raw): EnvironmentRow {
  return {
    id: String(raw.id ?? ''),
    env: (raw.env as string | null | undefined) ?? null,
    host: String(raw.host ?? ''),
    lastSeenAt: String(val(raw, 'lastSeenAt', 'last_seen_at') ?? ''),
    createdAt: String(val(raw, 'createdAt', 'created_at') ?? ''),
  }
}
