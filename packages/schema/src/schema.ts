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
  'user_message',
  'thinking',
  'tool_proposed',
  'tool_started',
  'tool_stdout_delta',
  'tool_result',
  'tool_cancelled',
  'tool_substituted',
  'subagent_started',
  'subagent_result',
  'plan',
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
    // The initial task/prompt the agent runs (null for sessions created without one).
    task: text('task'),
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

/**
 * Auth identity. `users` + `auth_sessions` back the self-hosted session auth
 * A high-entropy token is the bearer secret, and only its
 * SHA-256 hash is ever persisted (as `auth_sessions.id`), so the database never
 * stores a usable token. These tables are server-only — they are deliberately
 * NOT in the Electric proxy's synced collection set, so they never reach a
 * client. `sessions.user_id` (the coding-agent sessions above) holds a
 * `users.id`, which the JWT/bearer `sub` resolves to and the proxy scopes on.
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const authSessions = pgTable(
  'auth_sessions',
  {
    // SHA-256 hash (hex) of the opaque session token the client holds.
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
)
