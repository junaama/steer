import type { SessionStatus, ToolStatus } from '@steer/schema'

/** Status → label + CSS-variable color, from design-reference/DESIGN-SYSTEM.md. */
export interface StatusMeta {
  label: string
  color: string
}

export const SESSION_STATUS_META: Record<SessionStatus, StatusMeta> = {
  idle: { label: 'idle', color: 'var(--text-dim)' },
  starting: { label: 'connecting', color: 'var(--st-running)' },
  running: { label: 'running', color: 'var(--st-running)' },
  'awaiting-approval': { label: 'awaiting approval', color: 'var(--st-pending)' },
  interrupted: { label: 'interrupted', color: 'var(--st-pending)' },
  completed: { label: 'completed', color: 'var(--st-done)' },
  error: { label: 'error', color: 'var(--st-error)' },
}

export const TOOL_STATUS_META: Record<ToolStatus, StatusMeta> = {
  proposed: { label: 'proposed', color: 'var(--st-proposed)' },
  pending: { label: 'needs approval', color: 'var(--st-pending)' },
  running: { label: 'running', color: 'var(--st-running)' },
  cancelled: { label: 'cancelled', color: 'var(--st-cancelled)' },
  substituted: { label: 'substituted', color: 'var(--st-substituted)' },
  done: { label: 'done', color: 'var(--st-done)' },
  error: { label: 'error', color: 'var(--st-error)' },
}

/** Fallback so an unexpected status degrades to a neutral pill instead of crashing the render. */
const UNKNOWN_META: StatusMeta = { label: 'unknown', color: 'var(--text-dim)' }

export function sessionStatusMeta(status: string): StatusMeta {
  return SESSION_STATUS_META[status as SessionStatus] ?? UNKNOWN_META
}

export function toolStatusMeta(status: string): StatusMeta {
  return TOOL_STATUS_META[status as ToolStatus] ?? UNKNOWN_META
}

const TOOL_ICON: Record<string, string> = {
  read_file: 'read',
  read: 'read',
  grep: 'grep',
  glob: 'folder',
  list_dir: 'folder',
  ls: 'folder',
  web_fetch: 'globe',
  write_file: 'file',
  edit_file: 'edit',
  multi_edit: 'edit',
  bash: 'terminal',
  run_command: 'terminal',
  todo_write: 'check',
  task: 'swap',
  diagnostics: 'search',
  definition: 'search',
  references: 'grep',
  hover: 'search',
}

export function toolIcon(name: string): string {
  if (name.startsWith('mcp:')) return 'globe'
  return TOOL_ICON[name] ?? 'wrench'
}

export function relTime(fromMs: number, nowMs: number): string {
  const s = Math.max(1, Math.round((nowMs - fromMs) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
