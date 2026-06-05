/**
 * harness.ts (benchmark) — mirrors evals/harness.ts but for real benchmark
 * instances. Key differences from the read-only eval harness:
 *
 * 1. Clones the repo at `baseCommit` into a shallow, cached dir so the agent
 *    operates on the exact state the gold patch was written against.
 * 2. Runs with the FULL tool set (all side-effecting tools included) so the
 *    agent can actually edit files.
 * 3. Starts a background AUTO-APPROVER that inserts `approve` control rows for
 *    every pending side-effecting tool_proposed event. Without it the approval
 *    gate polls forever and the run never finishes.
 * 4. Extracts the agent's EDITED files via `git diff --name-only` on the real
 *    cloned dir — a genuine outcome measure, not an inference.
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, access } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { sessions, events as eventsTable, controls } from '@steer/schema'
import { createPool, createDb, type Db } from '../../src/db.js'
import { createDbStore, type AgentStore } from '../../src/store.js'
import { runSession } from '../../src/loop.js'
import { tools as allTools } from '../../src/tools/index.js'
import { createModelDriver } from '../../src/model.js'
import type { BenchmarkGolden, BenchmarkMeta } from './types.js'

const execAsync = promisify(exec)
const here = dirname(fileURLToPath(import.meta.url))

/** Cached repo root — `.gitignore`d so clones aren't committed. */
const REPOS_ROOT = join(here, '.repos')

/** What a benchmark run returns to the localization evaluator. */
export interface BenchmarkResult {
  /** Files the agent actually edited (from `git diff --name-only`). */
  editedFiles: string[]
  /** Gold files recorded in the golden's metadata. */
  goldFiles: string[]
  /** Tool names the agent proposed, in order. */
  toolsCalled: string[]
  /** Terminal session status. */
  status: string
  /** The agent's final assistant message. */
  answer: string
  sessionId: string
}

// ---------------------------------------------------------------------------
// Pool / store — lazily opened so importing this module doesn't need DB_URL.
// ---------------------------------------------------------------------------

let pool: ReturnType<typeof createPool> | undefined
let db: Db | undefined
let store: AgentStore | undefined

function ensure(): { db: Db; store: AgentStore } {
  if (!pool) {
    // Benchmark evals use EVAL_DATABASE_URL (steer_eval DB), falling through to
    // the normal DATABASE_URL so local dev without a separate eval DB still works.
    const connStr = process.env.EVAL_DATABASE_URL ?? process.env.DATABASE_URL
    pool = createPool(connStr)
    db = createDb(pool)
    store = createDbStore(db)
  }
  return { db: db!, store: store! }
}

// ---------------------------------------------------------------------------
// Repo clone (shallow, cached)
// ---------------------------------------------------------------------------

/**
 * Shallow-clone a specific commit into a cached directory. Safe to call
 * repeatedly — skips the clone if the dir already contains a `.git` directory.
 *
 * GitHub allows fetching a specific SHA by hash via:
 *   git fetch --depth 1 origin <sha>
 *
 * This is far faster than a full clone for large repos like astropy.
 */
async function ensureRepo(instanceId: string, repo: string, baseCommit: string): Promise<string> {
  const repoDir = join(REPOS_ROOT, instanceId)

  // Check if already cloned (has .git dir)
  try {
    await access(join(repoDir, '.git'))
    return repoDir // cache hit — skip clone
  } catch {
    // Not yet cloned — proceed
  }

  await mkdir(repoDir, { recursive: true })
  const url = `https://github.com/${repo}.git`

  console.log(`  Cloning ${repo}@${baseCommit.slice(0, 12)} …`)
  // Init + shallow-fetch the exact commit. --depth=1 with a specific SHA is the
  // fastest approach that avoids fetching the full history.
  await execAsync(`git init`, { cwd: repoDir })
  await execAsync(`git remote add origin ${url}`, { cwd: repoDir })
  // Fetch the exact commit SHA (GitHub supports this via uploadpack.allowReachableSHA1InWant)
  await execAsync(`git fetch --depth 1 origin ${baseCommit}`, { cwd: repoDir, timeout: 120_000 })
  await execAsync(`git checkout FETCH_HEAD`, { cwd: repoDir })

  console.log(`  Cloned → ${repoDir}`)
  return repoDir
}

// ---------------------------------------------------------------------------
// Auto-approver
// ---------------------------------------------------------------------------

type EventPayload = { toolCallId?: string; name?: string; kind?: string }

/**
 * Inspect the event log for side-effecting tool_proposed events that do not yet
 * have an approve/reject/override control and insert an `approve` control for
 * each so `resolveTool` (intercept.ts) unblocks the approval gate.
 *
 * The approve control payload shape `resolveTool` reads:
 *   { toolCallId: string; alwaysAllow?: boolean }
 *
 * `alwaysAllow: true` grants the tool name for the rest of the in-memory session
 * run — subsequent calls to the same tool bypass the gate entirely, so only the
 * first call per tool name needs an approval row in the DB.
 */
async function approveAllPending(sessionId: string, resolvedDb: Db): Promise<void> {
  // Find all side-effecting tool_proposed events for this session
  const rows = await resolvedDb
    .select({ type: eventsTable.type, payload: eventsTable.payload })
    .from(eventsTable)
    .where(eq(eventsTable.sessionId, sessionId))

  const proposed = new Map<string, string>() // toolCallId → tool name
  for (const row of rows) {
    if (row.type === 'tool_proposed') {
      const p = row.payload as EventPayload
      if (p.toolCallId && p.kind === 'side-effecting') {
        proposed.set(p.toolCallId, p.name ?? '')
      }
    }
  }

  if (proposed.size === 0) return

  // Find toolCallIds that already have a control (avoid duplicates)
  const existingControls = await resolvedDb
    .select({ payload: controls.payload })
    .from(controls)
    .where(eq(controls.sessionId, sessionId))

  const decided = new Set<string>()
  for (const row of existingControls) {
    const p = row.payload as { toolCallId?: string }
    if (p.toolCallId) decided.add(p.toolCallId)
  }

  // Insert approve controls for any undecided proposed calls
  for (const [toolCallId] of proposed) {
    if (decided.has(toolCallId)) continue
    await resolvedDb.insert(controls).values({
      id: randomUUID(),
      sessionId,
      type: 'approve',
      // alwaysAllow: true so subsequent calls to the same tool skip the gate
      payload: { toolCallId, alwaysAllow: true },
    })
  }
}

// ---------------------------------------------------------------------------
// Main benchmark run
// ---------------------------------------------------------------------------

/**
 * Run one BenchmarkGolden through the real agent loop:
 * - clones the repo at baseCommit (cached)
 * - seeds a session in the eval Postgres
 * - starts a background auto-approver so edits proceed without human input
 * - calls runSession with the FULL tool set
 * - extracts edited files from `git diff --name-only HEAD`
 * - returns a BenchmarkResult for the localization evaluator
 */
export async function runBenchmarkGolden(
  golden: BenchmarkGolden,
  timeoutMs = 180_000,
): Promise<BenchmarkResult> {
  const { db: resolvedDb, store: resolvedStore } = ensure()
  const meta = golden.metadata as BenchmarkMeta

  // Prepare workspace — clone the repo if this is a SWE-bench instance
  let repoDir: string
  if (meta.source === 'swebench-verified' && meta.repo && meta.baseCommit) {
    repoDir = await ensureRepo(meta.instanceId, meta.repo, meta.baseCommit)
  } else {
    // Terminal-bench: no upstream repo to clone; run in an isolated empty dir
    repoDir = join(REPOS_ROOT, meta.instanceId)
    await mkdir(repoDir, { recursive: true })
  }

  const sessionId = `bench-${randomUUID()}`
  const model = meta.model ?? 'haiku'

  await resolvedDb.insert(sessions).values({
    id: sessionId,
    userId: 'bench-eval',
    title: `[bench] ${meta.instanceId}`,
    task: String(golden.input).slice(0, 500),
    model,
    lastStatus: 'starting',
  })

  // Background auto-approver — polls every 500 ms and inserts approve controls
  // for any side-effecting tool_proposed events that are still awaiting decision.
  let approverStopped = false
  const approverInterval = setInterval(() => {
    if (approverStopped) return
    approveAllPending(sessionId, resolvedDb).catch((err: unknown) => {
      // Non-fatal: a transient DB error in the approver is logged but does not
      // crash the process. The run will time out if approval never arrives.
      console.error(`  auto-approver error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, 500)

  // SWE-bench inputs are raw GitHub issues — with no instruction to act, the
  // agent just explains the bug. Frame it as a fix task so it actually edits
  // (this is the eval posing the task, not changing the agent or the grader).
  const taskPrompt =
    meta.source === 'swebench-verified'
      ? `You are working inside a cloned copy of the ${meta.repo} repository. Resolve the issue below by EDITING the repository's source files with edit_file / multi_edit / write_file — do not merely describe the fix, apply it to the code. Stop once the change is made.\n\n--- ISSUE ---\n${String(golden.input)}`
      : String(golden.input)
  const driver = createModelDriver({ model, task: taskPrompt })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    await runSession(resolvedStore, driver, sessionId, {
      workspaceRoot: repoDir,
      root: repoDir,
      tools: allTools,
      maxSteps: meta.maxSteps ?? 30,
      pollMs: 300,
      signal: controller.signal,
    })
  } catch (err) {
    // Surface the cause — a swallowed run failure (model error, abort) otherwise
    // looks like "the agent did nothing" when the eval infra is what broke.
    console.error(`  [bench] run failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
    approverStopped = true
    clearInterval(approverInterval)
  }

  // Edited files — real outcome from the filesystem, not inference
  let editedFiles: string[] = []
  try {
    const { stdout } = await execAsync('git diff --name-only HEAD', { cwd: repoDir })
    editedFiles = stdout.trim().split('\n').filter((f) => f.length > 0)
  } catch {
    // git diff can fail for terminal-bench tasks where there's no real git repo
  }

  // Project event log → result shape
  const sessionEvents = await resolvedStore.listEvents(sessionId)
  const answerEvent = [...sessionEvents].reverse().find((e) => e.type === 'message')
  const answer = ((answerEvent?.payload as { text?: string } | undefined)?.text ?? '').trim()
  const toolsCalled = sessionEvents
    .filter((e) => e.type === 'tool_proposed')
    .map((e) => (e.payload as { name?: string }).name ?? '')
    .filter((name): name is string => name.length > 0)

  const [row] = await resolvedDb
    .select({ status: sessions.lastStatus })
    .from(sessions)
    .where(eq(sessions.id, sessionId))

  if (process.env.EVAL_KEEP !== '1') {
    await resolvedDb.delete(sessions).where(eq(sessions.id, sessionId)) // cascades events + controls
  }

  return {
    editedFiles,
    goldFiles: meta.goldFiles ?? [],
    toolsCalled,
    status: row?.status ?? 'unknown',
    answer,
    sessionId,
  }
}

/** Close the shared pool — call once when the benchmark run finishes. */
export async function closeBenchmarkHarness(): Promise<void> {
  await pool?.end()
  pool = undefined
  db = undefined
  store = undefined
}
