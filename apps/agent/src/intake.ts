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
  /** Absolute directory the session should run in (the CLI's cwd); null = daemon root. */
  workdir: string | null
}

// 'starting' = a fresh task; 'running' = a crashed run to resume (it replays in
// the shape's reconnect snapshot); 'awaiting-approval' = a run that crashed while
// blocked at the approval gate — resume so it re-reaches the gate; 'awaiting-input'
// = a run that crashed while blocked on an `ask_user` question — resume so it
// re-reaches the wait and re-finds any answer already given (R11). Everything else
// is terminal/idle — ignore it.
const RUNNABLE = new Set<SessionStatus>(['starting', 'running', 'awaiting-approval', 'awaiting-input'])

/**
 * Pure projection of a batch of Electric messages to the sessions that should
 * run *on this daemon's environment*. Electric streams the raw Postgres shape
 * (snake_case columns), and re-emits a row on every change, so callers must
 * dedupe (see the runner's `active` set). Control messages (up-to-date /
 * must-refetch) and move-outs (deletes) carry no runnable row and are skipped.
 *
 * `myEnv` is this daemon's routing identity: `null` means the default daemon,
 * which runs *unrouted* sessions (`environment` null/absent); a string means
 * this daemon runs only sessions explicitly tagged with that environment. This
 * is what makes "run it anywhere" deterministic — a row never reaches a daemon
 * whose filesystem it was not meant for.
 */
export function runnableFromMessages(messages: Message[], myEnv: string | null): SessionIntent[] {
  const out: SessionIntent[] = []
  for (const message of messages) {
    if (!isChangeMessage(message)) continue
    if (message.headers.operation === 'delete') continue

    const row = message.value
    const status = typeof row.last_status === 'string' ? row.last_status : ''
    if (!RUNNABLE.has(status as SessionStatus)) continue

    const rowEnv = typeof row.environment === 'string' ? row.environment : null
    const mine = myEnv === null ? rowEnv === null : rowEnv === myEnv
    if (!mine) continue

    const id = typeof row.id === 'string' ? row.id : ''
    if (id === '') continue

    out.push({
      id,
      model: typeof row.model === 'string' ? row.model : 'sonnet',
      task: typeof row.task === 'string' ? row.task : null,
      workdir: typeof row.workdir === 'string' ? row.workdir : null,
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
 * Subscribe to a sessions shape and invoke `onSession` for every runnable row
 * routed to this daemon's environment (`myEnv` — see `runnableFromMessages`).
 * Returns the stream's unsubscribe function.
 */
export function subscribeRunnable(
  stream: ShapeSubscriber,
  onSession: (intent: SessionIntent) => void,
  myEnv: string | null,
  onError?: (error: Error) => void,
): () => void {
  return stream.subscribe((messages) => {
    for (const intent of runnableFromMessages(messages, myEnv)) onSession(intent)
  }, onError)
}
