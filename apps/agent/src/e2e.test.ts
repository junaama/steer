import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions, controls, type EventType } from '@steer/schema'
import { createDb, type Db } from './db.js'
import { createDbStore, type AgentStore, type StoredEvent } from './store.js'
import { runSession, FakeStreamingModel, type ScriptedTurn } from './loop.js'
import { tools } from './tools/index.js'
import { ensureDefaultTestDatabase, testDatabaseUrl } from './test-db.js'

const TEST_URL = testDatabaseUrl()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let pool: pg.Pool
let db: Db
let store: AgentStore
let workspace: string

async function newSession(): Promise<string> {
  const id = randomUUID()
  await db.insert(sessions).values({ id, userId: 'u1', title: 'capstone', lastStatus: 'starting' })
  return id
}

function types(events: { type: EventType }[]): EventType[] {
  return events.map((event) => event.type)
}

async function sessionStatus(id: string): Promise<string> {
  const rows = await db.select({ status: sessions.lastStatus }).from(sessions).where(eq(sessions.id, id))
  return rows[0]!.status
}

/** Wait until the DB-synced session status reaches `target` (the gate/await pills). */
async function waitForStatus(id: string, target: string): Promise<void> {
  for (let i = 0; i < 400 && (await sessionStatus(id)) !== target; i++) await sleep(5)
  expect(await sessionStatus(id)).toBe(target)
}

function payloadFor<T extends Record<string, unknown>>(events: StoredEvent[], type: EventType, toolCallId: string): T {
  const event = events.find((candidate) => {
    const payload = candidate.payload as { toolCallId?: unknown }
    return candidate.type === type && payload.toolCallId === toolCallId
  })
  expect(event).toBeDefined()
  return event!.payload as T
}

beforeAll(async () => {
  await ensureDefaultTestDatabase()
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  db = createDb(pool)
  await migrate(db, { migrationsFolder: '../server/drizzle' })
  store = createDbStore(db)
  workspace = await mkdtemp(join(tmpdir(), 'steer-e2e-'))
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE sessions CASCADE;')
  // The files the capstone's read/edit/verify turns operate on.
  await writeFile(join(workspace, 'src.txt'), 'alpha\nbeta\ngamma\n')
  await writeFile(join(workspace, 'verify.txt'), 'status=red\n')
})

describe('live-agent capstone integration', () => {
  // One streamed session that drives the WHOLE integrated live experience and
  // asserts the REAL event log read back from the store (never an inferred output,
  // per the repo rule). The turns, in order, cover every acceptance example:
  //   AE1 — turn 1 streams reasoning + text deltas ALONGSIDE a tool call; the
  //         coalesced thinking/message AND the tool_proposed all persist (reasoning
  //         is not dropped, R2).
  //   AE5 — turn 2 proposes MULTIPLE tool calls; every one executes (3 tool_result).
  //   AE2 — turn 3 is a gated edit that parks awaiting-approval until an inserted
  //         `approve` control, and applies only after it.
  //   AE4 — turn 4 calls ask_user, parks awaiting-input until an answer
  //         (user_message) arrives, then resumes.
  //   AE6 — the run streams reasoning/text/tools/diff/clarify into one durable,
  //         synced event log throughout (the integrated live experience).
  //   AE3 — turn 5 verifies (run_command), turn 6 is a final no-tool message and
  //         the session ends `completed` (it never gave up early).
  it('streams reasoning+text+tools, gates an edit, clarifies, verifies, and ends completed (AE1–AE6)', async () => {
    const id = await newSession()
    const statusTransitions: string[] = []
    const observingStore: AgentStore = {
      ...store,
      async setStatus(sessionId, status) {
        statusTransitions.push(status)
        return store.setStatus(sessionId, status)
      },
    }
    const planItems = [
      { text: 'inspect the workspace', status: 'in_progress' },
      { text: 'apply the fix', status: 'pending' },
      { text: 'verify it is green', status: 'pending' },
    ]
    const verifyCommand = `node -e "process.stdout.write('all checks passed')"`
    const question = 'Which environment should I target?'
    const answer = 'staging'

    // The edit (turn 3) is the side-effecting tool whose diff must clear the
    // approval gate (AE2). Its approve control is inserted LIVE — only after the
    // run is observed parked awaiting-approval — so the gate genuinely blocks and
    // the edit can be proven un-applied while parked. ask_user (turn 4) is likewise
    // answered live via a user_message AFTER its question is emitted (pre-inserting
    // either would let the run race past the pill we assert). The verify
    // run_command (turn 5) is also side-effecting; its approval is pre-granted —
    // it only appears long after, so it can't be mistaken for the edit's decision.
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'run1', alwaysAllow: true } })

    const script: ScriptedTurn[] = [
      // Turn 1 (AE1): reasoning + text BOTH stream as coarse deltas alongside a
      // tool call. The two reasoning chunks coalesce into one thinking_delta row
      // (the first buffers under the size threshold, the second ends a sentence so
      // the combined buffer flushes), then a terminal thinking event; the text
      // chunk flushes one message_delta then a terminal message — proving reasoning
      // AND text persist beside the tool call (R2).
      {
        reasoningDeltas: ['First I inspect the files, ', 'then I plan the work.'],
        textDeltas: ['Starting on the task now.'],
        toolCalls: [{ toolCallId: 'todo1', name: 'todo_write', args: { items: planItems } }],
      },
      // Turn 2 (AE5): three read-only tool calls in ONE turn — all must execute.
      {
        toolCalls: [
          { toolCallId: 'read1', name: 'read_file', args: { path: 'src.txt' } },
          { toolCallId: 'grep1', name: 'grep', args: { pattern: 'beta', path: 'src.txt' } },
          { toolCallId: 'list1', name: 'list_dir', args: { path: '.' } },
        ],
      },
      // Turn 3 (AE2): a side-effecting edit — parks at the gate until approved.
      {
        reasoning: 'I found the bug; editing verify.txt and then verifying.',
        toolCalls: [{ toolCallId: 'edit1', name: 'edit_file', args: { path: 'verify.txt', old_string: 'status=red', new_string: 'status=green' } }],
      },
      // Turn 4 (AE4): ask the operator and WAIT for the answer (user_message).
      { toolCalls: [{ toolCallId: 'ask1', name: 'ask_user', args: { question } }] },
      // Turn 5: verify the fix landed (a real command, real captured output).
      { toolCalls: [{ toolCallId: 'run1', name: 'run_command', args: { command: verifyCommand } }] },
      // Turn 6 (AE3): final no-tool message ends the run — it never gave up early.
      { text: 'Done — the fix is in and verification is green.' },
    ]

    // Drive the session in the background so the test can react to the live pills:
    // approve nothing extra (the edit control is pre-inserted), but answer the
    // ask_user question only AFTER it is asked.
    const run = runSession(observingStore, new FakeStreamingModel(script), id, {
      workspaceRoot: workspace,
      tools,
      pollMs: 5,
    })

    // AE2: the edit parks at the approval gate. While parked, its proposal exists
    // (with before/after for diff-review) but NO tool_result, and the file is
    // untouched — the edit cannot apply before the operator approves.
    await waitForStatus(id, 'awaiting-approval')
    const atGate = await store.listEvents(id)
    expect(atGate.some((event) => event.type === 'tool_proposed' && (event.payload as { toolCallId?: string }).toolCallId === 'edit1')).toBe(true)
    expect(atGate.some((event) => event.type === 'tool_result' && (event.payload as { toolCallId?: string }).toolCallId === 'edit1')).toBe(false)
    expect(await readFile(join(workspace, 'verify.txt'), 'utf8')).toBe('status=red\n')

    // Approve the diff → the edit applies and the run advances.
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'edit1' } })

    // AE4: the run then reaches the ask_user question and parks awaiting-input.
    await waitForStatus(id, 'awaiting-input')
    const parked = await store.listEvents(id)
    const questionEvent = parked.find((event) => event.type === 'question')!.payload as { toolCallId: string; question: string }
    expect(questionEvent).toEqual({ toolCallId: 'ask1', question })
    // The ask_user call has been proposed but has NO result while parked.
    expect(parked.some((event) => event.type === 'tool_proposed' && (event.payload as { toolCallId?: string }).toolCallId === 'ask1')).toBe(true)
    expect(parked.some((event) => event.type === 'tool_result' && (event.payload as { toolCallId?: string }).toolCallId === 'ask1')).toBe(false)
    // The edit DID apply once approved (before the run advanced to the question).
    expect(await readFile(join(workspace, 'verify.txt'), 'utf8')).toBe('status=green\n')

    // The operator answers via the SAME carrier the web composer uses.
    await store.appendEvent(id, 'user_message', { text: answer })
    await run

    // ── Assert the REAL event log read back from the store (no inferred outputs) ──
    const events = await store.listEvents(id)
    expect(types(events)).toEqual([
      // Turn 1: both reasoning and text stream as coarse delta rows (flushed first,
      // in arrival order) and then coalesce into terminal thinking/message events,
      // followed by todo_write + its plan.
      'thinking_delta',
      'message_delta',
      'thinking',
      'message',
      'tool_proposed',
      'tool_result',
      'plan',
      // Turn 2: three read-only tools in one turn.
      'tool_proposed',
      'tool_result',
      'tool_proposed',
      'tool_result',
      'tool_proposed',
      'tool_result',
      // Turn 3: reasoning beside the gated edit, applied after approval.
      'thinking',
      'tool_proposed',
      'tool_result',
      // Turn 4: ask_user — proposed, question, the operator's answer, then result.
      'tool_proposed',
      'question',
      'user_message',
      'tool_result',
      // Turn 5: the verification run.
      'tool_proposed',
      'tool_result',
      // Turn 6: final message; completion reconciles the plan to all-done.
      'message',
      'plan',
    ])

    // AE1: the streamed reasoning persists as BOTH a delta row and a coalesced
    // thinking event ALONGSIDE the tool call — reasoning is not dropped (R2). Its
    // concatenated delta text equals the terminal thinking text.
    const thinkingDeltas = events.filter((event) => event.type === 'thinking_delta')
    const thinkingDeltaText = thinkingDeltas.map((event) => (event.payload as { text: string }).text).join('')
    expect(thinkingDeltaText).toBe('First I inspect the files, then I plan the work.')
    const firstThinking = events.find((event) => event.type === 'thinking')!.payload as { text: string }
    expect(firstThinking.text).toBe('First I inspect the files, then I plan the work.')

    // The streamed reply text likewise persists as delta rows that coalesce to the
    // terminal message text — the live transcript and the durable message agree.
    const messageDeltas = events.filter((event) => event.type === 'message_delta')
    const messageDeltaText = messageDeltas.map((event) => (event.payload as { text: string }).text).join('')
    expect(messageDeltaText).toBe('Starting on the task now.')
    const firstMessage = events.filter((event) => event.type === 'message')[0]!.payload as { text: string }
    expect(firstMessage.text).toBe('Starting on the task now.')

    // AE5: all THREE read-only tool calls in turn 2 executed, in order.
    const turn2Results = [
      payloadFor<{ name: string; result: string }>(events, 'tool_result', 'read1'),
      payloadFor<{ name: string; result: string }>(events, 'tool_result', 'grep1'),
      payloadFor<{ name: string; result: string }>(events, 'tool_result', 'list1'),
    ]
    expect(turn2Results.map((result) => result.name)).toEqual(['read_file', 'grep', 'list_dir'])
    expect(turn2Results[0]!.result).toBe('alpha\nbeta\ngamma\n')
    expect(turn2Results[1]!.result).toBe('src.txt:2:beta')
    expect(turn2Results[2]!.result).toContain('verify.txt')

    // AE2: the gated edit carries before/after for diff-review and only applied
    // after approve (asserted live above; the persisted proposal + file confirm it).
    const editProposed = payloadFor<{ before: string; after: string }>(events, 'tool_proposed', 'edit1')
    expect(editProposed.before).toBe('status=red\n')
    expect(editProposed.after).toBe('status=green\n')
    const editResult = payloadFor<{ name: string }>(events, 'tool_result', 'edit1')
    expect(editResult.name).toBe('edit_file')

    // AE4: the operator's answer is recorded as the ask_user tool_result and the
    // run resumed (asserted live: it parked awaiting-input until the user_message).
    const askResult = payloadFor<{ name: string; result: string }>(events, 'tool_result', 'ask1')
    expect(askResult).toMatchObject({ name: 'ask_user', result: answer })

    // Turn 5: the verification command's REAL captured output.
    const runResult = payloadFor<{ name: string; result: string }>(events, 'tool_result', 'run1')
    expect(runResult.result).toBe('all checks passed\n[exit 0]')

    // The plan artifact tracks the run: it starts mirroring the tool args, and the
    // completed session's final plan reads as all-done (no stale in-progress todos).
    const planEvents = events.filter((event) => event.type === 'plan')
    expect((planEvents[0]!.payload as { items: typeof planItems }).items).toEqual(planItems)
    expect((planEvents.at(-1)!.payload as { items: typeof planItems }).items).toEqual([
      { text: 'inspect the workspace', status: 'done' },
      { text: 'apply the fix', status: 'done' },
      { text: 'verify it is green', status: 'done' },
    ])

    // AE3: the approval gate fired for BOTH side-effecting tools — the edit (whose
    // approval arrived live) and the verify run_command (whose approval was
    // pre-granted, so it flipped the pill once then ran). The ask_user wait fired
    // once, and the run ended completed — it never gave up early.
    expect(statusTransitions.filter((status) => status === 'awaiting-approval')).toHaveLength(2)
    expect(statusTransitions.filter((status) => status === 'awaiting-input')).toHaveLength(1)
    const finalMessage = events.filter((event) => event.type === 'message').at(-1)!.payload as { text: string }
    expect(finalMessage.text).toBe('Done — the fix is in and verification is green.')
    expect(await readFile(join(workspace, 'verify.txt'), 'utf8')).toBe('status=green\n')
    expect(await sessionStatus(id)).toBe('completed')
  })
})
