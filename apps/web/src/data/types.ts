import type { EventType, SessionStatus, ImageAttachment } from '@steer/schema'

export interface SessionRow {
  id: string
  userId: string
  title: string
  task: string | null
  lastStatus: SessionStatus
  model: string
  /** The environment this session is routed to run on; null = unrouted. */
  environment: string | null
  /** The working directory hint for the session; null when not specified. */
  workdir: string | null
  /**
   * An optional image attached to the initial task (R14). Write-only from the web
   * side: it rides the optimistic insert so the collection's onInsert can forward
   * it to the write boundary; the authoritative synced row does not surface it for
   * rendering (the daemon reads `task_image` from its own shape). null = none.
   */
  taskImage?: ImageAttachment | null
  createdAt: string
  updatedAt: string
}

export interface EventRow {
  sessionId: string
  seq: number
  type: EventType
  payload: Record<string, unknown>
}

/** A registered daemon environment synced from the `environments` table. */
export interface EnvironmentRow {
  id: string
  env: string | null
  host: string
  lastSeenAt: string
  createdAt: string
}
