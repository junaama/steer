import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { mkdtemp, writeFile, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions, controls, type EventType } from '@steer/schema'
import { createDb, type Db } from './db.js'
import { createDbStore, type AgentStore, type StoredEvent } from './store.js'
import {
  runSession,
  FakeStreamingModel,
  completedSteps,
  isNoProgressRepeat,
  findCachedWebFetch,
  findAnswerAfter,
  questionSeqFor,
  latestPlan,
  planMarkedAllDone,
  type ScriptedTurn,
  type ModelDriver,
  type TurnResult,
} from './loop.js'
import { tools, type ToolFn } from './tools/index.js'
import { ensureDefaultTestDatabase, testDatabaseUrl } from './test-db.js'

const TEST_URL = testDatabaseUrl()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let pool: pg.Pool
let db: Db
let store: AgentStore
let workspace: string

async function newSession(): Promise<string> {
  const id = randomUUID()
  await db.insert(sessions).values({ id, userId: 'u1', title: 'task', lastStatus: 'starting' })
  return id
}

function types(events: { type: EventType }[]): EventType[] {
  return events.map((e) => e.type)
}

async function status(id: string): Promise<string> {
  const r = await db.select({ s: sessions.lastStatus }).from(sessions).where(eq(sessions.id, id))
  return r[0]!.s
}

async function fileExists(name: string): Promise<boolean> {
  return access(join(workspace, name)).then(
    () => true,
    () => false,
  )
}

/** A no-tool turn that emits text — the simplest way to end a run with a reply. */
const say = (text: string): ScriptedTurn => ({ text })
/** A turn that calls one tool (and ends only via a later no-tool turn). */
const callTool = (toolCallId: string, name: string, args: Record<string, unknown>): ScriptedTurn => ({
  toolCalls: [{ toolCallId, name, args }],
})

beforeAll(async () => {
  await ensureDefaultTestDatabase()
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  db = createDb(pool)
  await migrate(db, { migrationsFolder: '../server/drizzle' })
  store = createDbStore(db)
  workspace = await mkdtemp(join(tmpdir(), 'steer-loop-'))
  await writeFile(join(workspace, 'a.txt'), 'hello\nworld')
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE sessions CASCADE;')
})

describe('runSession', () => {
  it('emits ordered events for a streamed turn (reasoning + text + tool) and completes', async () => {
    const id = await newSession()
    const script: ScriptedTurn[] = [
      { reasoning: 'locating the file', text: 'reading it now', toolCalls: [{ toolCallId: 'tc1', name: 'read_file', args: { path: 'a.txt' } }] },
      say('done'),
    ]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['thinking', 'message', 'tool_proposed', 'tool_result', 'message'])
    const toolResult = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(toolResult.result).toContain('hello')
    expect(await status(id)).toBe('completed')
  })

  it('persists BOTH reasoning and a tool proposal in one turn — reasoning is not dropped (AE1, R2)', async () => {
    const id = await newSession()
    const script: ScriptedTurn[] = [
      { reasoning: 'I should grep before editing', toolCalls: [{ toolCallId: 'g1', name: 'grep', args: { pattern: 'hello', path: 'a.txt' } }] },
      say('found it'),
    ]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    // The turn's reasoning persists as a terminal thinking event ALONGSIDE the
    // tool proposal — the old "tool wins, text discarded" bug is fixed.
    expect(types(events)).toEqual(['thinking', 'tool_proposed', 'tool_result', 'message'])
    const thinking = events.find((e) => e.type === 'thinking')!.payload as { text: string }
    expect(thinking.text).toBe('I should grep before editing')
    expect(await status(id)).toBe('completed')
  })

  it('executes ALL THREE read-only tool calls in one turn (AE5, multi-tool per turn)', async () => {
    const id = await newSession()
    const script: ScriptedTurn[] = [
      {
        reasoning: 'inspect three things at once',
        toolCalls: [
          { toolCallId: 't1', name: 'read_file', args: { path: 'a.txt' } },
          { toolCallId: 't2', name: 'grep', args: { pattern: 'world', path: 'a.txt' } },
          { toolCallId: 't3', name: 'list_dir', args: { path: '.' } },
        ],
      },
      say('all read'),
    ]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(events.filter((e) => e.type === 'tool_proposed')).toHaveLength(3)
    const results = events.filter((e) => e.type === 'tool_result')
    expect(results).toHaveLength(3)
    expect((results[0]!.payload as { name: string }).name).toBe('read_file')
    expect((results[1]!.payload as { name: string }).name).toBe('grep')
    expect((results[2]!.payload as { name: string }).name).toBe('list_dir')
    expect(await status(id)).toBe('completed')
  })

  it('gates a side-effecting tool inside a multi-call turn and waits for approval before its result', async () => {
    const id = await newSession()
    // Turn batches a read THEN a write; the write must park at the gate
    // (awaiting-approval) and only run its tool_result after an approve control.
    const script: ScriptedTurn[] = [
      {
        toolCalls: [
          { toolCallId: 'r1', name: 'read_file', args: { path: 'a.txt' } },
          { toolCallId: 'w1', name: 'write_file', args: { path: 'batch.txt', content: 'X' } },
        ],
      },
      say('wrote it'),
    ]
    const p = runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
    // The read runs immediately; the write parks at the gate.
    for (let i = 0; i < 200 && (await status(id)) !== 'awaiting-approval'; i++) await sleep(5)
    expect(await status(id)).toBe('awaiting-approval')
    const mid = await store.listEvents(id)
    // The read already produced a result; the write has only been proposed.
    expect(mid.filter((e) => e.type === 'tool_result')).toHaveLength(1)
    expect(await fileExists('batch.txt')).toBe(false)
    // Approve the write → it executes and the run finishes.
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'w1' } })
    await p
    expect(await fileExists('batch.txt')).toBe(true)
    expect(await status(id)).toBe('completed')
  })

  it('streams coarse message_delta rows that coalesce to the final message text', async () => {
    const id = await newSession()
    // Deltas flush on boundaries / size; their concatenation equals the terminal
    // message text. The driver streams multiple sentences so several rows flush.
    const chunks = ['First sentence. ', 'Second sentence! ', 'And the third part is a bit longer to cross the size threshold for a flush.']
    const script: ScriptedTurn[] = [{ textDeltas: chunks }]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools })

    const events = await store.listEvents(id)
    const deltas = events.filter((e) => e.type === 'message_delta')
    expect(deltas.length).toBeGreaterThan(1) // coarse, but more than one row
    const joinedDeltas = deltas.map((e) => (e.payload as { text: string }).text).join('')
    const message = events.find((e) => e.type === 'message')!.payload as { text: string }
    expect(joinedDeltas).toBe(chunks.join('')) // every streamed char represented
    expect(message.text).toBe(chunks.join('').trim())
    expect(await status(id)).toBe('completed')
  })

  it('streams coarse thinking_delta rows that coalesce to the final thinking text', async () => {
    const id = await newSession()
    const chunks = ['Weighing the options.\n', 'I will read the file first.']
    const script: ScriptedTurn[] = [{ reasoningDeltas: chunks, toolCalls: [{ toolCallId: 'r1', name: 'read_file', args: { path: 'a.txt' } }] }, say('done')]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const deltas = events.filter((e) => e.type === 'thinking_delta')
    const joined = deltas.map((e) => (e.payload as { text: string }).text).join('')
    const thinking = events.find((e) => e.type === 'thinking')!.payload as { text: string }
    expect(joined).toBe(chunks.join(''))
    expect(thinking.text).toBe(chunks.join('').trim())
  })

  it('force-stops a non-completing model at the step cap (no runaway)', async () => {
    const id = await newSession()
    // A model that never finishes a turn without a tool — mirrors the empty-dir
    // loop that produced dozens of identical tool calls.
    let n = 0
    const looping: ModelDriver = {
      next: async () => ({ reasoning: '', text: '', toolCalls: [{ toolCallId: `t${n++}`, name: 'list_dir', args: { path: 'src' } }] }),
    }
    // Each turn commits one tool_result (one step). Different dir results so the
    // no-progress guard never trips — only the cap stops it.
    await runSession(store, looping, id, { workspaceRoot: workspace, tools, maxSteps: 3, pollMs: 5 })

    const events = await store.listEvents(id)
    // 3 tool results consume the budget; the cap notice is the 4th terminal message.
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(3)
    const capMsg = events.filter((e) => e.type === 'message').at(-1)!.payload as { text: string }
    expect(capMsg.text).toContain('safety limit')
    expect(await status(id)).toBe('error')
  })

  it('stops with a no-progress message when the model repeats an identical call, before the cap', async () => {
    const id = await newSession()
    // The empty-dir flail: the model re-proposes the same read_file (same bytes
    // back every time), each with a fresh toolCallId like a real model would.
    let n = 0
    const stuck: ModelDriver = {
      next: async () => ({ reasoning: '', text: '', toolCalls: [{ toolCallId: `tc${n++}`, name: 'read_file', args: { path: 'a.txt' } }] }),
    }
    await runSession(store, stuck, id, { workspaceRoot: workspace, tools, maxSteps: 80, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(3) // REPEAT_LIMIT, not 80
    const msg = events.filter((e) => e.type === 'message').at(-1)!.payload as { text: string }
    expect(msg.text).toContain('read_file')
    expect(msg.text).toContain('no progress')
    expect(await status(id)).toBe('error')
  })

  it('stops a varied-but-fruitless search (grep, changing args, identical "no matches") before the cap', async () => {
    const id = await newSession()
    let n = 0
    const thrash: ModelDriver = {
      next: async () => ({ reasoning: '', text: '', toolCalls: [{ toolCallId: `tc${n}`, name: 'grep', args: { pattern: `zzz${n++}`, path: 'a.txt' } }] }),
    }
    await runSession(store, thrash, id, { workspaceRoot: workspace, tools, maxSteps: 80, pollMs: 5 })

    const events = await store.listEvents(id)
    const results = events.filter((e) => e.type === 'tool_result')
    expect(results).toHaveLength(3) // REPEAT_LIMIT, not 80 — bounded despite varied args
    expect((results[0]!.payload as { result: string }).result).toBe('— no matches')
    const msg = events.filter((e) => e.type === 'message').at(-1)!.payload as { text: string }
    expect(msg.text).toContain('grep')
    expect(msg.text).toContain('no progress')
    expect(await status(id)).toBe('error')
  })

  it('stops a no-progress repeat that appears later within a multi-tool batch', async () => {
    const id = await newSession()
    // One turn batches four identical reads; the fourth would extend the streak,
    // so the no-progress guard stops mid-batch (only three results persist).
    const repeat = (i: number) => ({ toolCallId: `b${i}`, name: 'read_file', args: { path: 'a.txt' } })
    const script: ScriptedTurn[] = [{ toolCalls: [repeat(0), repeat(1), repeat(2), repeat(3)] }]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(3)
    expect(await status(id)).toBe('error')
  })

  it('halts on an interrupt control row and records it (control-plane-via-data-plane)', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'interrupt', payload: {} })
    const script: ScriptedTurn[] = [
      { reasoning: 'a', text: 'b', toolCalls: [{ toolCallId: 'tc1', name: 'list_dir', args: { path: '.' } }] },
    ]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['interrupted'])
    expect(await status(id)).toBe('interrupted')
  })

  it('resumes from the event log after a crash without re-running committed steps', async () => {
    const id = await newSession()
    const script: ScriptedTurn[] = [
      { reasoning: 'step0', toolCalls: [{ toolCallId: 'tc1', name: 'list_dir', args: { path: '.' } }] },
      say('step-final'),
    ]
    // Turn 1 commits thinking(1) + tool_result(1) = cursor 2. Crash when the
    // driver is next asked at cursor 2 (i.e. after turn 1 fully committed).
    await expect(
      runSession(store, new FakeStreamingModel(script, { failAtCursor: 2 }), id, { workspaceRoot: workspace, tools, pollMs: 5 }),
    ).rejects.toThrow(/crash/)

    const afterCrash = await store.listEvents(id)
    expect(completedSteps(afterCrash)).toBe(2)
    expect(types(afterCrash)).toEqual(['thinking', 'tool_proposed', 'tool_result'])

    // Resume with a healthy driver — recomputes cursor 2 from the log and finishes.
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const final = await store.listEvents(id)
    expect(types(final)).toEqual(['thinking', 'tool_proposed', 'tool_result', 'message'])
    expect(final.filter((e) => e.type === 'thinking')).toHaveLength(1)
    expect(final.filter((e) => e.type === 'tool_result')).toHaveLength(1)
    expect(await status(id)).toBe('completed')
  })

  it('treats streamed deltas plus one terminal message as a single completed step (DB-backed cursor)', async () => {
    const id = await newSession()
    await store.appendEvent(id, 'thinking_delta', { text: 'plan' })
    await store.appendEvent(id, 'message_delta', { text: 'Hel' })
    await store.appendEvent(id, 'message_delta', { text: 'lo' })
    await store.appendEvent(id, 'message', { text: 'Hello' })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['thinking_delta', 'message_delta', 'message_delta', 'message'])
    expect(completedSteps(events)).toBe(1)
  })

  it('captures tool errors as a tool_result instead of throwing', async () => {
    const id = await newSession()
    const script: ScriptedTurn[] = [callTool('tc1', 'read_file', { path: 'missing.txt' }), say('handled')]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const result = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toMatch(/^error:/)
    expect(await status(id)).toBe('completed')
  })

  it('emits a write_file proposal with before/after and writes on approval', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'tc1' } })
    const script: ScriptedTurn[] = [callTool('tc1', 'write_file', { path: 'new.txt', content: 'l1\nl2' }), say('wrote')]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBe('') // new file
    expect(proposed.after).toBe('l1\nl2')
    expect(events.some((e) => e.type === 'tool_result')).toBe(true)
  })

  it('emits an edit_file proposal with before/after matching the approved edit', async () => {
    const id = await newSession()
    await writeFile(join(workspace, 'edit-proposal.txt'), 'alpha\nbeta\ngamma\n')
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'tc1' } })
    const script: ScriptedTurn[] = [
      callTool('tc1', 'edit_file', { path: 'edit-proposal.txt', old_string: 'beta', new_string: 'delta' }),
      say('edited'),
    ]

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBe('alpha\nbeta\ngamma\n')
    expect(proposed.after).toBe('alpha\ndelta\ngamma\n')
    expect(await readFile(join(workspace, 'edit-proposal.txt'), 'utf8')).toBe('alpha\ndelta\ngamma\n')
  })

  it('emits a multi_edit proposal with after reflecting all edits', async () => {
    const id = await newSession()
    await writeFile(join(workspace, 'multi-proposal.txt'), 'one\ntwo\nthree\n')
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'tc1' } })
    const script: ScriptedTurn[] = [
      callTool('tc1', 'multi_edit', {
        path: 'multi-proposal.txt',
        edits: [
          { old_string: 'one', new_string: 'two' },
          { old_string: 'two\ntwo', new_string: 'double' },
        ],
      }),
      say('edited'),
    ]

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBe('one\ntwo\nthree\n')
    expect(proposed.after).toBe('double\nthree\n')
  })

  it('emits a grep proposal without before/after', async () => {
    const id = await newSession()
    const script: ScriptedTurn[] = [callTool('tc1', 'grep', { pattern: 'hello', path: 'a.txt' }), say('done')]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBeUndefined()
    expect(proposed.after).toBeUndefined()
  })

  it('emits no before/after when an edit_file proposal lacks editable strings', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'reject', payload: { toolCallId: 'tc1' } })
    const script: ScriptedTurn[] = [callTool('tc1', 'edit_file', { path: 'a.txt' })]

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBeUndefined()
    expect(proposed.after).toBeUndefined()
  })

  it('emits no before/after for a malformed multi_edit proposal', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'reject', payload: { toolCallId: 'tc1' } })
    const script: ScriptedTurn[] = [callTool('tc1', 'multi_edit', { path: 'a.txt', edits: [null] })]

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBeUndefined()
    expect(proposed.after).toBeUndefined()
  })

  it('emits no before/after when edit preview cannot match uniquely', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'reject', payload: { toolCallId: 'tc1' } })
    const script: ScriptedTurn[] = [
      callTool('tc1', 'edit_file', { path: 'a.txt', old_string: 'missing', new_string: 'replacement' }),
    ]

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBeUndefined()
    expect(proposed.after).toBeUndefined()
  })

  it('flips to awaiting-approval at a side-effecting gate, then back to running, then completed', async () => {
    const id = await newSession()
    const script: ScriptedTurn[] = [callTool('tc1', 'write_file', { path: 'gated.txt', content: 'X' }), say('wrote it')]
    const p = runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
    for (let i = 0; i < 100 && (await status(id)) !== 'awaiting-approval'; i++) await sleep(5)
    expect(await status(id)).toBe('awaiting-approval')
    expect(await fileExists('gated.txt')).toBe(false)
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'tc1' } })
    await p
    expect(await status(id)).toBe('completed')
    expect(await fileExists('gated.txt')).toBe(true)
  })

  it('keeps a read-only tool in running and never enters awaiting-approval', async () => {
    const id = await newSession()
    const seen: string[] = []
    const observingStore: AgentStore = {
      ...store,
      async setStatus(sid, st) {
        seen.push(st)
        return store.setStatus(sid, st)
      },
    }
    const script: ScriptedTurn[] = [callTool('tc1', 'read_file', { path: 'a.txt' }), say('done')]
    await runSession(observingStore, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
    expect(seen).not.toContain('awaiting-approval')
    expect(await status(id)).toBe('completed')
  })

  it('records todo_write as a normal read-only tool_result and a plan event', async () => {
    const id = await newSession()
    const items = [
      { text: 'write schema tests', status: 'pending' },
      { text: 'wire agent loop', status: 'in_progress' },
      { text: 'render todo panel', status: 'done' },
    ]
    const script: ScriptedTurn[] = [callTool('todo1', 'todo_write', { items })]

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['tool_proposed', 'tool_result', 'plan', 'plan'])
    const result = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toBe('Updated plan · 3 items')
    const plan = events.find((e) => e.type === 'plan')!.payload as { items: typeof items }
    expect(plan.items).toEqual(items)
    expect(await status(id)).toBe('completed')
  })

  it('does not append a plan event when todo_write args are malformed', async () => {
    const id = await newSession()
    const script: ScriptedTurn[] = [callTool('todo1', 'todo_write', { items: [{ text: 'bad', status: 'blocked' }] })]

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['tool_proposed', 'tool_result'])
    const result = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toMatch(/^error:/)
  })

  it('marks every open plan item done when the run completes, so the plan matches Complete', async () => {
    const id = await newSession()
    const items = [
      { text: 'write schema tests', status: 'done' },
      { text: 'wire agent loop', status: 'in_progress' },
      { text: 'render todo panel', status: 'pending' },
    ]
    const script: ScriptedTurn[] = [callTool('todo1', 'todo_write', { items })]

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const planEvents = events.filter((e) => e.type === 'plan')
    expect(planEvents).toHaveLength(2)
    const finalPlan = planEvents.at(-1)!.payload as { items: { text: string; status: string }[] }
    expect(finalPlan.items).toEqual([
      { text: 'write schema tests', status: 'done' },
      { text: 'wire agent loop', status: 'done' },
      { text: 'render todo panel', status: 'done' },
    ])
    expect(await status(id)).toBe('completed')
  })

  it('does not append a redundant plan event when the plan already reads as all done', async () => {
    const id = await newSession()
    const items = [
      { text: 'one', status: 'done' },
      { text: 'two', status: 'done' },
    ]
    const script: ScriptedTurn[] = [callTool('todo1', 'todo_write', { items })]

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(events.filter((e) => e.type === 'plan')).toHaveLength(1)
    expect(await status(id)).toBe('completed')
  })

  it('leaves an unfinished plan untouched when the run errors out instead of completing', async () => {
    const id = await newSession()
    const items = [{ text: 'keep going', status: 'in_progress' }]
    let n = 0
    const stuck: ModelDriver = {
      next: async () => {
        if (n++ === 0) {
          return { reasoning: '', text: '', toolCalls: [{ toolCallId: 'todo1', name: 'todo_write', args: { items } }] }
        }
        return { reasoning: '', text: '', toolCalls: [{ toolCallId: `r${n}`, name: 'read_file', args: { path: 'a.txt' } }] }
      },
    }

    await runSession(store, stuck, id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const planEvents = events.filter((e) => e.type === 'plan')
    expect(planEvents).toHaveLength(1) // no reconciling plan on the error path
    expect((planEvents[0]!.payload as { items: { status: string }[] }).items[0]!.status).toBe('in_progress')
    expect(await status(id)).toBe('error')
  })

  it('auto-runs a second run_command after an alwaysAllow approval without re-entering awaiting-approval', async () => {
    const id = await newSession()
    await db.insert(controls).values({
      id: randomUUID(),
      sessionId: id,
      type: 'approve',
      payload: { toolCallId: 'r1', alwaysAllow: true },
    })
    const seen: string[] = []
    const observingStore: AgentStore = {
      ...store,
      async setStatus(sid, st) {
        seen.push(st)
        return store.setStatus(sid, st)
      },
    }
    const script: ScriptedTurn[] = [
      callTool('r1', 'run_command', { command: 'pnpm test' }),
      callTool('r2', 'run_command', { command: 'pnpm test' }),
      say('green'),
    ]
    const fakeRun: ToolFn = async (args) => `ran ${(args.command as string) ?? ''}`

    await runSession(observingStore, new FakeStreamingModel(script), id, {
      workspaceRoot: workspace,
      tools: { ...tools, run_command: fakeRun },
      pollMs: 5,
    })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['tool_proposed', 'tool_result', 'tool_proposed', 'tool_result', 'message'])
    expect(seen.filter((s) => s === 'awaiting-approval')).toHaveLength(1)
    expect(await status(id)).toBe('completed')
  })

  it('gates a second run_command again when the first approval is one-time', async () => {
    const id = await newSession()
    await db.insert(controls).values({
      id: randomUUID(),
      sessionId: id,
      type: 'approve',
      payload: { toolCallId: 'r1' },
    })
    const seen: string[] = []
    const observingStore: AgentStore = {
      ...store,
      async setStatus(sid, st) {
        seen.push(st)
        return store.setStatus(sid, st)
      },
    }
    const script: ScriptedTurn[] = [
      callTool('r1', 'run_command', { command: 'pnpm test' }),
      callTool('r2', 'run_command', { command: 'pnpm test' }),
      say('green'),
    ]
    const p = runSession(observingStore, new FakeStreamingModel(script), id, {
      workspaceRoot: workspace,
      tools: { ...tools, run_command: async () => 'ran' },
      pollMs: 5,
    })

    for (let i = 0; i < 100; i++) {
      const events = await store.listEvents(id)
      const secondRunProposed = events.some((e) => {
        const payload = e.payload as { toolCallId?: string }
        return e.type === 'tool_proposed' && payload.toolCallId === 'r2'
      })
      if (secondRunProposed && (await status(id)) === 'awaiting-approval') break
      await sleep(5)
    }

    expect(await status(id)).toBe('awaiting-approval')
    expect(seen.filter((s) => s === 'awaiting-approval')).toHaveLength(2)
    await db.insert(controls).values({
      id: randomUUID(),
      sessionId: id,
      type: 'approve',
      payload: { toolCallId: 'r2' },
    })
    await p
    expect(await status(id)).toBe('completed')
  })

  it('runs a multi-turn edit→failing-run→edit→passing-run→message sequence and ends completed (AE3, R5)', async () => {
    const id = await newSession()
    await db.insert(controls).values([
      { id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'e1' } },
      { id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'r1', alwaysAllow: true } },
      { id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'e2' } },
    ])
    // Distinct turns: the failing run must not let the agent give up early — it
    // keeps working (edit again, re-run) until verification is green, then ends.
    const script: ScriptedTurn[] = [
      { reasoning: 'first fix', toolCalls: [{ toolCallId: 'e1', name: 'edit_file', args: { path: 'verify.txt', old_string: 'red', new_string: 'green' } }] },
      callTool('r1', 'run_command', { command: 'pnpm test' }),
      { reasoning: 'tests failed, fix again', toolCalls: [{ toolCallId: 'e2', name: 'edit_file', args: { path: 'verify.txt', old_string: 'green', new_string: 'blue' } }] },
      callTool('r2', 'run_command', { command: 'pnpm test' }),
      say('tests pass'),
    ]
    const runResults = ['failing test output\n[exit 1]', 'passing test output\n[exit 0]']
    const fakeTools: Record<string, ToolFn> = {
      ...tools,
      edit_file: async (args) => `edited ${(args.path as string) ?? ''}`,
      run_command: async () => runResults.shift() ?? 'unexpected\n[exit 1]',
    }

    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools: fakeTools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual([
      'thinking',
      'tool_proposed',
      'tool_result',
      'tool_proposed',
      'tool_result',
      'thinking',
      'tool_proposed',
      'tool_result',
      'tool_proposed',
      'tool_result',
      'message',
    ])
    const results = events.filter((e) => e.type === 'tool_result').map((e) => (e.payload as { result: string }).result)
    expect(results).toEqual([
      'edited verify.txt',
      'failing test output\n[exit 1]',
      'edited verify.txt',
      'passing test output\n[exit 0]',
    ])
    expect(await status(id)).toBe('completed')
  })

  it('asks a question, parks awaiting-input, waits for the operator answer, then resumes (AE4, R11)', async () => {
    const id = await newSession()
    const question = 'Which folder holds the README?'
    const script: ScriptedTurn[] = [
      { reasoning: 'I do not know the folder', toolCalls: [{ toolCallId: 'ask1', name: 'ask_user', args: { question } }] },
      say('found it in dev/yourai'),
    ]
    const p = runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    // The loop must PARK on the question and NOT advance until an answer arrives.
    for (let i = 0; i < 200 && (await status(id)) !== 'awaiting-input'; i++) await sleep(5)
    expect(await status(id)).toBe('awaiting-input')
    const parked = await store.listEvents(id)
    // The question is emitted; no ask_user tool_result yet (the run is blocked).
    const questionEvent = parked.find((e) => e.type === 'question')!.payload as { toolCallId: string; question: string }
    expect(questionEvent).toEqual({ toolCallId: 'ask1', question })
    expect(parked.some((e) => e.type === 'tool_proposed')).toBe(true)
    expect(parked.some((e) => e.type === 'tool_result')).toBe(false)
    // The follow-up reply has not been sent, so the run is still parked.
    expect(await status(id)).toBe('awaiting-input')

    // Operator answers via the SAME carrier the web composer uses — a user_message.
    await store.appendEvent(id, 'user_message', { text: 'dev/yourai' })
    await p

    const events = await store.listEvents(id)
    // The answer is recorded as the ask_user tool_result; the run then completes.
    const answerResult = events.find((e) => e.type === 'tool_result')!.payload as { name: string; result: string }
    expect(answerResult).toMatchObject({ name: 'ask_user', result: 'dev/yourai' })
    expect(types(events)).toEqual(['thinking', 'tool_proposed', 'question', 'user_message', 'tool_result', 'message'])
    expect(await status(id)).toBe('completed')
  })

  it('does not treat a follow-up sent BEFORE the question as the answer (seq-keyed)', async () => {
    const id = await newSession()
    // A pre-existing user_message must NOT be mistaken for the answer — the loop
    // must still park and wait for a reply that comes AFTER the question.
    await store.appendEvent(id, 'user_message', { text: 'stale message before any question' })
    const script: ScriptedTurn[] = [
      { toolCalls: [{ toolCallId: 'ask1', name: 'ask_user', args: { question: 'real question?' } }] },
      say('done'),
    ]
    const p = runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
    for (let i = 0; i < 200 && (await status(id)) !== 'awaiting-input'; i++) await sleep(5)
    expect(await status(id)).toBe('awaiting-input')
    // Still parked — the stale pre-question message did not answer it.
    await sleep(30)
    expect(await status(id)).toBe('awaiting-input')
    expect((await store.listEvents(id)).some((e) => e.type === 'tool_result')).toBe(false)
    // A real answer after the question resumes the run.
    await store.appendEvent(id, 'user_message', { text: 'the real answer' })
    await p
    const result = (await store.listEvents(id)).find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toBe('the real answer')
    expect(await status(id)).toBe('completed')
  })

  it('surfaces a malformed ask_user (empty question) as a tool error and does not park', async () => {
    const id = await newSession()
    // An empty question can't be answered — it must not park the run forever.
    const script: ScriptedTurn[] = [
      { toolCalls: [{ toolCallId: 'ask1', name: 'ask_user', args: { question: '' } }] },
      say('moved on'),
    ]
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(events.some((e) => e.type === 'question')).toBe(false)
    const result = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toMatch(/^error: ask_user requires/)
    // The run did not deadlock — it continued to the next turn and completed.
    expect(await status(id)).toBe('completed')
  })

  it('halts a run that is awaiting an ask_user answer when an interrupt arrives (no deadlock)', async () => {
    const id = await newSession()
    const script: ScriptedTurn[] = [
      { toolCalls: [{ toolCallId: 'ask1', name: 'ask_user', args: { question: 'which one?' } }] },
      say('unreached'),
    ]
    const p = runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
    for (let i = 0; i < 200 && (await status(id)) !== 'awaiting-input'; i++) await sleep(5)
    expect(await status(id)).toBe('awaiting-input')
    // Interrupt while awaiting the answer — the wait must end, not deadlock.
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'interrupt', payload: {} })
    await p
    expect(await status(id)).toBe('interrupted')
    const events = await store.listEvents(id)
    expect(events.some((e) => e.type === 'interrupted')).toBe(true)
    // No answer was given, so the ask_user call never produced a tool_result.
    expect(events.some((e) => e.type === 'tool_result')).toBe(false)
  })

  it('resumes an awaiting-input run from the log and finds an answer already given (crash-resume)', async () => {
    const id = await newSession()
    const question = 'target env?'
    const script: ScriptedTurn[] = [
      { toolCalls: [{ toolCallId: 'ask1', name: 'ask_user', args: { question } }] },
      say('resumed and finished'),
    ]
    // First run parks on the question; simulate a crash by aborting the run while
    // it is awaiting-input (the question + status live in the log).
    const ac = new AbortController()
    const first = runSession(store, new FakeStreamingModel(script), id, {
      workspaceRoot: workspace,
      tools,
      pollMs: 5,
      signal: ac.signal,
    })
    for (let i = 0; i < 200 && (await status(id)) !== 'awaiting-input'; i++) await sleep(5)
    expect(await status(id)).toBe('awaiting-input')
    ac.abort()
    await first

    // The operator answers while the daemon is down.
    await store.appendEvent(id, 'user_message', { text: 'staging' })

    // A fresh run (resume) recomputes from the log, re-reaches the wait, finds the
    // answer already present, and finishes — the answer was never lost.
    await runSession(store, new FakeStreamingModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
    const events = await store.listEvents(id)
    const result = events.filter((e) => e.type === 'tool_result').at(-1)!.payload as { name: string; result: string }
    expect(result).toMatchObject({ name: 'ask_user', result: 'staging' })
    expect(await status(id)).toBe('completed')
  })

  it('halts mid-tool when an interrupt arrives during execution', async () => {
    const id = await newSession()
    const slow: ToolFn = (_a, ctx) =>
      new Promise<string>((res, rej) => {
        const t = setTimeout(() => res('SLOW'), 500)
        ctx.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          rej(new Error('aborted'))
        })
      })
    const script: ScriptedTurn[] = [callTool('tc1', 'grep', { pattern: 'x', path: 'a.txt' })]
    const p = runSession(store, new FakeStreamingModel(script), id, {
      workspaceRoot: workspace,
      tools: { ...tools, grep: slow },
      pollMs: 5,
    })
    await sleep(40)
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'interrupt', payload: {} })
    await p
    expect(await status(id)).toBe('interrupted')
    const events = await store.listEvents(id)
    expect(events.some((e) => e.type === 'interrupted')).toBe(true)
  })
})

describe('completedSteps (delta events are non-terminal)', () => {
  const sev = (seq: number, type: EventType, payload: unknown): StoredEvent => ({ sessionId: 's', seq, type, payload })

  it('counts only terminal events, ignoring message_delta and thinking_delta', () => {
    const events: StoredEvent[] = [
      sev(0, 'thinking_delta', { text: 'weigh' }),
      sev(1, 'thinking_delta', { text: 'ing' }),
      sev(2, 'message_delta', { text: 'Hel' }),
      sev(3, 'message_delta', { text: 'lo' }),
      sev(4, 'message', { text: 'Hello' }),
    ]
    expect(completedSteps(events)).toBe(1)
  })

  it('a log of only deltas counts as zero completed steps (no terminal yet)', () => {
    const events: StoredEvent[] = [
      sev(0, 'message_delta', { text: 'partial' }),
      sev(1, 'thinking_delta', { text: 'still streaming' }),
    ]
    expect(completedSteps(events)).toBe(0)
  })
})

describe('isNoProgressRepeat', () => {
  const sev = (seq: number, type: EventType, payload: unknown): StoredEvent => ({ sessionId: 's', seq, type, payload })
  const prop = (seq: number, tcId: string, name: string, args: Record<string, unknown>): StoredEvent =>
    sev(seq, 'tool_proposed', { toolCallId: tcId, name, kind: 'read-only', args })
  const res = (seq: number, tcId: string, name: string, result: string): StoredEvent =>
    sev(seq, 'tool_result', { toolCallId: tcId, name, result })
  const run = (n: number, result = 'same'): StoredEvent[] =>
    Array.from({ length: n }, (_, i) => [
      prop(i * 2, `t${i}`, 'list_dir', { path: '.' }),
      res(i * 2 + 1, `t${i}`, 'list_dir', result),
    ]).flat()
  const same = { name: 'list_dir', args: { path: '.' } }

  it('is false until the same call+result has run REPEAT_LIMIT times', () => {
    expect(isNoProgressRepeat(run(2), same)).toBe(false)
  })

  it('is true on the proposal that would repeat an identical call once too many', () => {
    expect(isNoProgressRepeat(run(3), same)).toBe(true)
  })

  it('is false when the repeated call returned changing results (that is progress)', () => {
    const mixed = [...run(2, 'x'), prop(4, 'c', 'list_dir', { path: '.' }), res(5, 'c', 'list_dir', 'y')]
    expect(isNoProgressRepeat(mixed, same)).toBe(false)
  })

  it('is false when the proposed call differs from the recent run', () => {
    expect(isNoProgressRepeat(run(3), { name: 'list_dir', args: { path: 'src' } })).toBe(false)
    expect(isNoProgressRepeat(run(3), { name: 'read_file', args: { path: '.' } })).toBe(false)
  })

  it('ignores non-tool events, orphan results, and non-terminal tool events', () => {
    const evs = [
      sev(0, 'message', { text: 'hi' }),
      res(1, 'orphan', 'list_dir', 'same'),
      sev(2, 'tool_started', { toolCallId: 'a' }),
      ...run(3),
    ]
    expect(isNoProgressRepeat(evs, same)).toBe(true)
  })

  const fruitlessSearch = (name: string, argsList: Record<string, unknown>[], result: string): StoredEvent[] =>
    argsList.flatMap((args, i) => [prop(i * 2, `s${i}`, name, args), res(i * 2 + 1, `s${i}`, name, result)])

  it('stops a grep that keeps returning the same fruitless result on varied paths', () => {
    const evs = fruitlessSearch(
      'grep',
      [{ pattern: 'content-length', path: '.' }, { pattern: 'content-length', path: 'adapters.py' }, { pattern: 'content-length', path: 'sessions.py' }],
      '— no matches',
    )
    expect(isNoProgressRepeat(evs, { name: 'grep', args: { pattern: 'content-length', path: 'models.py' } })).toBe(true)
  })

  it('stops a glob that keeps returning the same fruitless result on varied patterns', () => {
    const evs = fruitlessSearch('glob', [{ pattern: '*.py' }, { pattern: '*.txt' }, { pattern: '*.md' }], '— no files')
    expect(isNoProgressRepeat(evs, { name: 'glob', args: { pattern: '*.json' } })).toBe(true)
  })

  it('does not stop a varied search whose results actually differ (that is progress)', () => {
    const evs = [
      prop(0, 'g0', 'grep', { pattern: 'x', path: 'a.py' }), res(1, 'g0', 'grep', 'a.py:1:x'),
      prop(2, 'g1', 'grep', { pattern: 'x', path: 'b.py' }), res(3, 'g1', 'grep', 'b.py:2:x'),
      prop(4, 'g2', 'grep', { pattern: 'x', path: 'c.py' }), res(5, 'g2', 'grep', 'c.py:3:x'),
    ]
    expect(isNoProgressRepeat(evs, { name: 'grep', args: { pattern: 'x', path: 'd.py' } })).toBe(false)
  })

  it('does not stop when the proposed call switches to a different search tool', () => {
    const evs = fruitlessSearch('grep', [{ path: '.' }, { path: 'a' }, { path: 'b' }], '— no matches')
    expect(isNoProgressRepeat(evs, { name: 'glob', args: { pattern: '*.py' } })).toBe(false)
  })

  it('does not apply the varied-args rule to non-search tools (e.g. list_dir, read_file)', () => {
    const reads = fruitlessSearch('read_file', [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }], 'X')
    expect(isNoProgressRepeat(reads, { name: 'read_file', args: { path: 'd.ts' } })).toBe(false)
    const lists = fruitlessSearch('list_dir', [{ path: '.' }, { path: 'src' }, { path: 'lib' }], '')
    expect(isNoProgressRepeat(lists, { name: 'list_dir', args: { path: 'test' } })).toBe(false)
  })
})

describe('findCachedWebFetch', () => {
  const sev = (seq: number, type: EventType, payload: unknown): StoredEvent => ({ sessionId: 's', seq, type, payload })
  const wfProp = (seq: number, tcId: string, url: string): StoredEvent =>
    sev(seq, 'tool_proposed', { toolCallId: tcId, name: 'web_fetch', kind: 'read-only', args: { url } })
  const wfRes = (seq: number, tcId: string, result: string): StoredEvent =>
    sev(seq, 'tool_result', { toolCallId: tcId, name: 'web_fetch', result })

  it('returns the cached result when a prior web_fetch on the same URL exists', () => {
    const events: StoredEvent[] = [
      wfProp(0, 'tc1', 'https://example.com/page'),
      wfRes(1, 'tc1', 'page content here'),
    ]
    expect(findCachedWebFetch(events, 'https://example.com/page')).toBe('page content here')
  })

  it('returns undefined when no prior web_fetch exists', () => {
    expect(findCachedWebFetch([], 'https://example.com/page')).toBeUndefined()
  })

  it('returns undefined when a prior web_fetch used a different URL', () => {
    const events: StoredEvent[] = [
      wfProp(0, 'tc1', 'https://example.com/other'),
      wfRes(1, 'tc1', 'other content'),
    ]
    expect(findCachedWebFetch(events, 'https://example.com/page')).toBeUndefined()
  })

  it('returns undefined when a web_fetch proposal exists but has no result yet', () => {
    const events: StoredEvent[] = [wfProp(0, 'tc1', 'https://example.com/page')]
    expect(findCachedWebFetch(events, 'https://example.com/page')).toBeUndefined()
  })

  it('returns the first matching result when the same URL was fetched multiple times', () => {
    const events: StoredEvent[] = [
      wfProp(0, 'tc1', 'https://example.com/page'),
      wfRes(1, 'tc1', 'first fetch'),
      wfProp(2, 'tc2', 'https://example.com/page'),
      wfRes(3, 'tc2', 'second fetch'),
    ]
    expect(findCachedWebFetch(events, 'https://example.com/page')).toBe('first fetch')
  })

  it('ignores non-web_fetch tool proposals when scanning for a URL', () => {
    const events: StoredEvent[] = [
      sev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'read_file', kind: 'read-only', args: { path: 'a.txt' } }),
      sev(1, 'tool_result', { toolCallId: 'tc1', name: 'read_file', result: 'file content' }),
    ]
    expect(findCachedWebFetch(events, 'https://example.com/page')).toBeUndefined()
  })
})

describe('runSession web_fetch dedup', () => {
  it('returns the cached result on a duplicate web_fetch without tripping the no-progress guard', async () => {
    const id = await newSession()
    const fetchUrl = 'https://example.com/cached-page'
    const fakeFetch: ToolFn = async (args) => {
      const url = (args as { url?: string }).url ?? ''
      return `content of ${url}`
    }

    const script: ScriptedTurn[] = [
      callTool('wf1', 'web_fetch', { url: fetchUrl }),
      callTool('wf2', 'web_fetch', { url: fetchUrl }),
      say('done'),
    ]

    await runSession(store, new FakeStreamingModel(script), id, {
      workspaceRoot: workspace,
      tools: { ...tools, web_fetch: fakeFetch },
      pollMs: 5,
    })

    const events = await store.listEvents(id)
    expect(events.filter((e) => e.type === 'tool_proposed')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2)
    const results = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e.payload as { result: string }).result)
    expect(results[0]).toBe(`content of ${fetchUrl}`)
    expect(results[1]).toBe(`content of ${fetchUrl}`)
    expect(await status(id)).toBe('completed')
  })
})

describe('findAnswerAfter', () => {
  const sev = (seq: number, type: EventType, payload: unknown): StoredEvent => ({ sessionId: 's', seq, type, payload })

  it('returns the text of the first user_message after the given seq', () => {
    const events = [
      sev(0, 'question', { toolCallId: 'a1', question: 'which?' }),
      sev(1, 'user_message', { text: 'this one' }),
    ]
    expect(findAnswerAfter(events, 0)).toBe('this one')
  })

  it('ignores a user_message at or before the given seq (a pre-question follow-up)', () => {
    const events = [
      sev(0, 'user_message', { text: 'stale' }),
      sev(1, 'question', { toolCallId: 'a1', question: 'which?' }),
    ]
    expect(findAnswerAfter(events, 1)).toBeUndefined()
  })

  it('returns undefined when no answer has arrived yet', () => {
    expect(findAnswerAfter([sev(0, 'question', { toolCallId: 'a1', question: 'q' })], 0)).toBeUndefined()
  })

  it('defaults a missing answer text to empty string', () => {
    expect(findAnswerAfter([sev(1, 'user_message', {})], 0)).toBe('')
  })
})

describe('questionSeqFor', () => {
  const sev = (seq: number, type: EventType, payload: unknown): StoredEvent => ({ sessionId: 's', seq, type, payload })

  it('returns the seq of the question for a given ask_user call', () => {
    const events = [
      sev(0, 'tool_proposed', { toolCallId: 'a1', name: 'ask_user', kind: 'side-effecting', args: {} }),
      sev(1, 'question', { toolCallId: 'a1', question: 'which?' }),
    ]
    expect(questionSeqFor(events, 'a1')).toBe(1)
  })

  it('returns undefined when no question exists for that call (first reach)', () => {
    expect(questionSeqFor([sev(0, 'message', { text: 'hi' })], 'a1')).toBeUndefined()
  })

  it('ignores a question for a different ask_user call', () => {
    expect(questionSeqFor([sev(0, 'question', { toolCallId: 'other', question: 'q' })], 'a1')).toBeUndefined()
  })
})

describe('latestPlan', () => {
  const sev = (seq: number, type: EventType, payload: unknown): StoredEvent => ({ sessionId: 's', seq, type, payload })

  it('returns null when the log has no plan event', () => {
    expect(latestPlan([sev(0, 'message', { text: 'hi' })])).toBeNull()
  })

  it('returns the items of the most recent plan event', () => {
    const events = [
      sev(0, 'plan', { items: [{ text: 'a', status: 'pending' }] }),
      sev(1, 'message', { text: 'working' }),
      sev(2, 'plan', { items: [{ text: 'a', status: 'in_progress' }] }),
    ]
    expect(latestPlan(events)).toEqual([{ text: 'a', status: 'in_progress' }])
  })

  it('returns null when the latest plan payload has no items array', () => {
    expect(latestPlan([sev(0, 'plan', { items: 'oops' })])).toBeNull()
  })
})

describe('planMarkedAllDone', () => {
  it('returns null when there is no plan', () => {
    expect(planMarkedAllDone(null)).toBeNull()
  })

  it('returns null for an empty plan', () => {
    expect(planMarkedAllDone([])).toBeNull()
  })

  it('flips every pending/in_progress item to done and keeps done items', () => {
    const items = [
      { text: 'a', status: 'done' as const },
      { text: 'b', status: 'in_progress' as const },
      { text: 'c', status: 'pending' as const },
    ]
    expect(planMarkedAllDone(items)).toEqual([
      { text: 'a', status: 'done' },
      { text: 'b', status: 'done' },
      { text: 'c', status: 'done' },
    ])
  })

  it('returns null when the plan already reads as all done (no redundant event)', () => {
    const items = [
      { text: 'a', status: 'done' as const },
      { text: 'b', status: 'done' as const },
    ]
    expect(planMarkedAllDone(items)).toBeNull()
  })
})

describe('FakeStreamingModel', () => {
  it('maps a terminal-count cursor onto the right scripted turn (crash-safe indexing)', async () => {
    // Turn 0 costs 2 terminals (thinking + tool); turn 1 is a no-tool reply. A
    // cursor of 2 (after turn 0 committed) must resolve to turn 1, proving the
    // driver derives the turn purely from the log cursor.
    const driver = new FakeStreamingModel([
      { reasoning: 'plan', toolCalls: [{ toolCallId: 't1', name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'second turn' },
    ])
    const noHooks = {}
    const turn0: TurnResult = await driver.next([], 0, noHooks)
    expect(turn0.toolCalls).toHaveLength(1)
    const turn1: TurnResult = await driver.next([], 2, noHooks)
    expect(turn1).toEqual({ reasoning: '', text: 'second turn', toolCalls: [] })
  })

  it('streams scripted deltas through the hooks in order', async () => {
    const driver = new FakeStreamingModel([{ reasoningDeltas: ['a', 'b'], textDeltas: ['x', 'y'] }])
    const reasoning: string[] = []
    const text: string[] = []
    const result = await driver.next([], 0, {
      onReasoningDelta: (c) => reasoning.push(c),
      onTextDelta: (c) => text.push(c),
    })
    expect(reasoning).toEqual(['a', 'b'])
    expect(text).toEqual(['x', 'y'])
    // Concatenated deltas are the coalesced text/reasoning when not overridden.
    expect(result).toEqual({ reasoning: 'ab', text: 'xy', toolCalls: [] })
  })

  it('returns an empty no-tool turn past the end of the script (ends the run)', async () => {
    const driver = new FakeStreamingModel([{ text: 'only turn' }])
    expect(await driver.next([], 5, {})).toEqual({ reasoning: '', text: '', toolCalls: [] })
  })
})
