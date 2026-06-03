import { pgTable, text, integer, jsonb, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'

/**
 * The data model — one append-only event log is the writable truth; `messages`,
 * tool calls, and session status are projections/folds over it. Controls carry
 * operator intent (interrupt / approve / reject / override) into the agent.
 */

export const SESSION_STATUSES = [
  'idle',
  'starting',
  'running',
  'awaiting-approval',
  'interrupted',
  'completed',
  'error',
] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export const EVENT_TYPES = [
  'message',
  'thinking',
  'tool_proposed',
  'tool_started',
  'tool_stdout_delta',
  'tool_result',
  'tool_cancelled',
  'tool_substituted',
  'status_changed',
  'interrupted',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const CONTROL_TYPES = ['interrupt', 'approve', 'reject', 'override'] as const
export type ControlType = (typeof CONTROL_TYPES)[number]

/** Per-tool-call lifecycle status (a projection over the event log). */
export const TOOL_STATUSES = [
  'proposed',
  'pending',
  'running',
  'cancelled',
  'substituted',
  'done',
  'error',
] as const
export type ToolStatus = (typeof TOOL_STATUSES)[number]

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),
    lastStatus: text('last_status').$type<SessionStatus>().notNull().default('idle'),
    model: text('model').notNull().default('sonnet'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const events = pgTable(
  'events',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // Monotonic per session. The composite PK enforces uniqueness + ordering.
    seq: integer('seq').notNull(),
    type: text('type').$type<EventType>().notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
)

export const controls = pgTable(
  'controls',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: text('type').$type<ControlType>().notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [index('controls_session_idx').on(t.sessionId)],
)
