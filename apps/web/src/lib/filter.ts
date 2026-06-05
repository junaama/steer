import type { SessionStatus } from '@steer/schema'

export interface SessionView {
  id: string
  title: string
  task?: string | null
  lastStatus: SessionStatus
  model: string
  /** The environment this session is routed to run on; null/absent = unrouted. */
  environment?: string | null
  updatedAt: number
}

export type FilterId = 'all' | 'running' | 'interrupted' | 'completed' | 'error'

const LIVE: SessionStatus[] = ['running', 'starting', 'awaiting-approval', 'awaiting-input']

/** Narrow the session list by title query and status filter (pure). */
export function filterSessions(list: readonly SessionView[], query: string, filter: FilterId): SessionView[] {
  const q = query.trim().toLowerCase()
  return list.filter((s) => {
    if (q && !s.title.toLowerCase().includes(q)) return false
    if (filter === 'all') return true
    if (filter === 'running') return LIVE.includes(s.lastStatus)
    return s.lastStatus === filter
  })
}
