import type { EventType, SessionStatus } from '@steer/schema'

export interface SessionRow {
  id: string
  userId: string
  title: string
  task: string | null
  lastStatus: SessionStatus
  model: string
  /** The environment this session is routed to run on; null = unrouted. */
  environment: string | null
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
