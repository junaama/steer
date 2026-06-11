import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { READ_ONLY_TOOLS, sessions } from '@steer/schema'
import { createPool, createDb, type Db } from '../src/db.js'
import { createDbStore, type AgentStore } from '../src/store.js'
import { runSession } from '../src/loop.js'
import { tools as allTools } from '../src/tools/index.js'
import { createModelDriver } from '../src/model.js'
import { resolveSessionWorkspace } from '../src/workspace.js'
import type { Golden, GoldenMetadata } from './goldens.js'
import type { ConversationGolden } from './conversation.js'

/** What the eval task returns to the evaluators — all read off the REAL event log. */
export interface TaskResult {
  /** The agent's final assistant message (last `message` event text). */
  answer: string
  /** Tool names the agent proposed, in order (`tool_proposed` events). */
  toolsCalled: string[]
  /** Terminal session status from the DB row (`completed` | `error` | …). */
  status: string
  sessionId: string
}

const here = dirname(fileURLToPath(import.meta.url))
export const fixturesRoot = join(here, 'fixtures')

// Lazily opened so importing this module (e.g. for the TaskResult type) never
// requires DATABASE_URL — only actually running a golden does.
let pool: ReturnType<typeof createPool> | undefined
let db: Db | undefined
let store: AgentStore | undefined

function ensure(): { db: Db; store: AgentStore } {
  if (!pool) {
    pool = createPool()
    db = createDb(pool)
    store = createDbStore(db)
  }
  return { db: db!, store: store! }
}

function resolveGoldenWorkspace(meta: GoldenMetadata): { root: string; workspaceRoot: string; homeDir?: string } {
  const root = join(fixturesRoot, meta.rootFixture ?? meta.fixture)
  const homeDir = meta.homeFixture ? join(fixturesRoot, meta.homeFixture) : undefined
  const workspaceRoot = meta.sessionWorkdir
    ? homeDir
      ? resolveSessionWorkspace(root, meta.sessionWorkdir, () => homeDir)
      : resolveSessionWorkspace(root, meta.sessionWorkdir)
    : join(fixturesRoot, meta.fixture)
  return homeDir ? { root, workspaceRoot, homeDir } : { root, workspaceRoot }
}

/**
 * Run one golden through the REAL agent loop against a test Postgres + the
 * fixture workspace, then project the actual event log into a TaskResult.
 *
 * The driver is scoped to READ_ONLY_TOOLS so the model can never propose a
 * side-effecting tool (which would block forever at the approval gate). An
 * AbortController caps total wall-clock per golden as a backstop.
 */
export async function runGolden(golden: Golden, timeoutMs = 90_000): Promise<TaskResult> {
  const { db, store } = ensure()
  const meta = golden.metadata as GoldenMetadata
  const model = meta.model ?? 'haiku'
  const sessionId = `eval-${randomUUID()}`
  const workspace = resolveGoldenWorkspace(meta)

  await db.insert(sessions).values({
    id: sessionId,
    userId: 'eval-user',
    title: String(golden.input).slice(0, 80),
    task: String(golden.input),
    model,
    lastStatus: 'starting',
    workdir: meta.sessionWorkdir,
  })

  const driver = createModelDriver({ model, task: String(golden.input), tools: READ_ONLY_TOOLS })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await runSession(store, driver, sessionId, {
      ...workspace,
      tools: allTools,
      maxSteps: meta.maxSteps ?? 12,
      signal: controller.signal,
    })
  } catch {
    // An aborted or failed run still left a real (partial) event log to score.
  } finally {
    clearTimeout(timer)
  }

  return projectResult(sessionId)
}

/**
 * Project the REAL event log into a TaskResult: the last assistant message, the
 * proposed-tool names in order, and the terminal session status from the DB.
 * Deletes the session afterwards (cascades events) unless EVAL_KEEP=1.
 */
async function projectResult(sessionId: string): Promise<TaskResult> {
  const { db, store } = ensure()
  const events = await store.listEvents(sessionId)
  const answerEvent = [...events].reverse().find((e) => e.type === 'message')
  const answer = ((answerEvent?.payload as { text?: string } | undefined)?.text ?? '').trim()
  const toolsCalled = events
    .filter((e) => e.type === 'tool_proposed')
    .map((e) => (e.payload as { name?: string }).name ?? '')
    .filter((name): name is string => name.length > 0)
  const [row] = await db.select({ status: sessions.lastStatus }).from(sessions).where(eq(sessions.id, sessionId))

  if (process.env.EVAL_KEEP !== '1') {
    await db.delete(sessions).where(eq(sessions.id, sessionId)) // cascades events
  }
  return { answer, toolsCalled, status: row?.status ?? 'unknown', sessionId }
}

/**
 * Run a MULTI-TURN golden: the original task, then each follow-up injected as a
 * `user_message` once the prior turn settles — mirroring how the daemon resumes a
 * session when the user sends another message. The same driver carries the
 * original task, so this exercises whether the agent MAINTAINS the conversation
 * (completes the original request after a clarification) rather than answering
 * each message in isolation. The final answer is scored off the real event log.
 */
export async function runConversationGolden(
  golden: ConversationGolden,
  timeoutMs = 120_000,
): Promise<TaskResult> {
  const { db, store } = ensure()
  const meta = golden.metadata
  const model = meta.model ?? 'haiku'
  const sessionId = `eval-${randomUUID()}`
  const workspace = resolveGoldenWorkspace(meta)

  await db.insert(sessions).values({
    id: sessionId,
    userId: 'eval-user',
    title: golden.input.slice(0, 80),
    task: golden.input,
    model,
    lastStatus: 'starting',
    workdir: meta.sessionWorkdir,
  })

  const driver = createModelDriver({ model, task: golden.input, tools: READ_ONLY_TOOLS })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const runOpts = {
    ...workspace,
    tools: allTools,
    maxSteps: meta.maxSteps ?? 24,
    signal: controller.signal,
  }
  try {
    await runSession(store, driver, sessionId, runOpts)
    for (const followUp of golden.followUps) {
      // Inject the follow-up exactly as the server does, then resume the loop.
      await store.appendEvent(sessionId, 'user_message', { text: followUp })
      await runSession(store, driver, sessionId, runOpts)
    }
  } catch {
    // A partial (aborted/failed) log is still real and worth scoring.
  } finally {
    clearTimeout(timer)
  }

  return projectResult(sessionId)
}

/** Close the shared pool — call once when the eval run finishes. */
export async function closeHarness(): Promise<void> {
  await pool?.end()
  pool = undefined
  db = undefined
  store = undefined
}
