import type { EventType, SessionStatus } from '@steer/schema'

export interface SessionRow {
  id: string
  userId: string
  title: string
  task: string | null
  lastStatus: SessionStatus
  model: string
  createdAt: string
  updatedAt: string
}

export interface EventRow {
  sessionId: string
  seq: number
  type: EventType
  payload: Record<string, unknown>
}
