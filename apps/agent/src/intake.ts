import { isChangeMessage, type Message } from '@electric-sql/client'
import type { SessionStatus } from '@steer/schema'

/**
 * Session intake via Electric SQL sync (PRD 4.d). The daemon learns which
 * sessions need work by subscribing to the `sessions` shape — the same read
 * path the UI uses — instead of polling Postgres directly. Event write-back
 * stays a direct, trusted server-side write (PRD 4.e); only the intake is sync.
 */

/** What the runner needs to start a session. Derived from a synced shape row. */
export interface SessionIntent {
  id: string
  model: string
  task: string | null
}

// 'starting' = a fresh task; 'running' = a crashed run to resume (it replays in
// the shape's reconnect snapshot). Everything else is terminal/idle — ignore it.
const RUNNABLE = new Set<SessionStatus>(['starting', 'running'])

/**
 * Pure projection of a batch of Electric messages to the sessions that should
 * run. Electric streams the raw Postgres shape (snake_case columns), and
 * re-emits a row on every change, so callers must dedupe (see the runner's
 * `active` set). Control messages (up-to-date / must-refetch) and move-outs
 * (deletes) carry no runnable row and are skipped.
 */
export function runnableFromMessages(messages: Message[]): SessionIntent[] {
  const out: SessionIntent[] = []
  for (const message of messages) {
    if (!isChangeMessage(message)) continue
    if (message.headers.operation === 'delete') continue

    const row = message.value
    const status = typeof row.last_status === 'string' ? row.last_status : ''
    if (!RUNNABLE.has(status as SessionStatus)) continue

    const id = typeof row.id === 'string' ? row.id : ''
    if (id === '') continue

    out.push({
      id,
      model: typeof row.model === 'string' ? row.model : 'sonnet',
      task: typeof row.task === 'string' ? row.task : null,
    })
  }
  return out
}

/** The minimal slice of `ShapeStream` the intake needs — keeps it testable. */
export interface ShapeSubscriber {
  subscribe(
    callback: (messages: Message[]) => void,
    onError?: (error: Error) => void,
  ): () => void
}

/**
 * Subscribe to a sessions shape and invoke `onSession` for every runnable row.
 * Returns the stream's unsubscribe function.
 */
export function subscribeRunnable(
  stream: ShapeSubscriber,
  onSession: (intent: SessionIntent) => void,
  onError?: (error: Error) => void,
): () => void {
  return stream.subscribe((messages) => {
    for (const intent of runnableFromMessages(messages)) onSession(intent)
  }, onError)
}
