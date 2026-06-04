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
import { runSession, ScriptedModel, completedSteps, isNoProgressRepeat, type Step, type ModelDriver } from './loop.js'
import { tools, type ToolFn } from './tools/index.js'

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://steer:steer@localhost:54321/steer?sslmode=disable'
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

beforeAll(async () => {
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
  it('emits ordered events for a scripted run and completes', async () => {
    const id = await newSession()
    const script: Step[] = [
      { t: 'thinking', text: 'locating the file' },
      { t: 'say', text: 'reading it now' },
      { t: 'tool', toolCallId: 'tc1', name: 'read_file', args: { path: 'a.txt' } },
      { t: 'say', text: 'done' },
    ]
    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['thinking', 'message', 'tool_proposed', 'tool_result', 'message'])
    const toolResult = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(toolResult.result).toContain('hello')
    expect(await status(id)).toBe('completed')
  })

  it('force-stops a non-completing model at the step cap (no runaway)', async () => {
    const id = await newSession()
    // A model that never returns `complete` — mirrors the empty-dir loop that
    // produced dozens of identical tool calls.
    const looping: ModelDriver = { next: async () => ({ t: 'say', text: 'still going' }) }
    await runSession(store, looping, id, { workspaceRoot: workspace, tools, maxSteps: 3 })

    const events = await store.listEvents(id)
    const messages = events.filter((e) => e.type === 'message')
    expect(messages).toHaveLength(4) // 3 model steps + the cap notice
    expect((messages[3]!.payload as { text: string }).text).toContain('safety limit')
    expect(await status(id)).toBe('error')
  })

  it('stops with a no-progress message when the model repeats an identical call, before the cap', async () => {
    const id = await newSession()
    // The empty-dir flail: the model re-proposes the same read_file (same bytes
    // back every time), each with a fresh toolCallId like a real model would.
    let n = 0
    const stuck: ModelDriver = {
      next: async () => ({ t: 'tool', toolCallId: `tc${n++}`, name: 'read_file', args: { path: 'a.txt' } }),
    }
    await runSession(store, stuck, id, { workspaceRoot: workspace, tools, maxSteps: 80 })

    const events = await store.listEvents(id)
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(3) // REPEAT_LIMIT, not 80
    const msg = events.filter((e) => e.type === 'message').at(-1)!.payload as { text: string }
    expect(msg.text).toContain('read_file')
    expect(msg.text).toContain('no progress')
    expect(await status(id)).toBe('error')
  })

  it('halts on an interrupt control row and records it (control-plane-via-data-plane)', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'interrupt', payload: {} })
    const script: Step[] = [
      { t: 'thinking', text: 'a' },
      { t: 'say', text: 'b' },
      { t: 'tool', toolCallId: 'tc1', name: 'list_dir', args: { path: '.' } },
    ]
    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['interrupted'])
    expect(await status(id)).toBe('interrupted')
  })

  it('resumes from the event log after a crash without re-running committed steps', async () => {
    const id = await newSession()
    const script: Step[] = [
      { t: 'thinking', text: 'step0' },
      { t: 'say', text: 'step1' },
      { t: 'tool', toolCallId: 'tc1', name: 'list_dir', args: { path: '.' } },
      { t: 'say', text: 'step3' },
    ]
    // Crash before step index 2 (the tool) runs.
    await expect(
      runSession(store, new ScriptedModel(script, { failAtCursor: 2 }), id, { workspaceRoot: workspace, tools }),
    ).rejects.toThrow(/crash/)

    const afterCrash = await store.listEvents(id)
    expect(completedSteps(afterCrash)).toBe(2)
    expect(types(afterCrash)).toEqual(['thinking', 'message'])

    // Resume with a healthy driver — continues from cursor 2.
    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools })

    const final = await store.listEvents(id)
    expect(types(final)).toEqual(['thinking', 'message', 'tool_proposed', 'tool_result', 'message'])
    // exactly one terminal per step — committed steps were not re-run
    expect(final.filter((e) => e.type === 'thinking')).toHaveLength(1)
    expect(final.filter((e) => e.type === 'tool_result')).toHaveLength(1)
    expect(await status(id)).toBe('completed')
  })

  it('captures tool errors as a tool_result instead of throwing', async () => {
    const id = await newSession()
    const script: Step[] = [{ t: 'tool', toolCallId: 'tc1', name: 'read_file', args: { path: 'missing.txt' } }]
    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools })

    const events = await store.listEvents(id)
    const result = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toMatch(/^error:/)
    expect(await status(id)).toBe('completed')
  })

  it('emits a write_file proposal with before/after and writes on approval', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'tc1' } })
    const script: Step[] = [{ t: 'tool', toolCallId: 'tc1', name: 'write_file', args: { path: 'new.txt', content: 'l1\nl2' } }]
    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
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
    const script: Step[] = [
      {
        t: 'tool',
        toolCallId: 'tc1',
        name: 'edit_file',
        args: { path: 'edit-proposal.txt', old_string: 'beta', new_string: 'delta' },
      },
    ]

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

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
    const script: Step[] = [
      {
        t: 'tool',
        toolCallId: 'tc1',
        name: 'multi_edit',
        args: {
          path: 'multi-proposal.txt',
          edits: [
            { old_string: 'one', new_string: 'two' },
            { old_string: 'two\ntwo', new_string: 'double' },
          ],
        },
      },
    ]

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBe('one\ntwo\nthree\n')
    expect(proposed.after).toBe('double\nthree\n')
  })

  it('emits a grep proposal without before/after', async () => {
    const id = await newSession()
    const script: Step[] = [{ t: 'tool', toolCallId: 'tc1', name: 'grep', args: { pattern: 'hello', path: 'a.txt' } }]
    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBeUndefined()
    expect(proposed.after).toBeUndefined()
  })

  it('emits no before/after when an edit_file proposal lacks editable strings', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'reject', payload: { toolCallId: 'tc1' } })
    const script: Step[] = [{ t: 'tool', toolCallId: 'tc1', name: 'edit_file', args: { path: 'a.txt' } }]

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBeUndefined()
    expect(proposed.after).toBeUndefined()
  })

  it('emits no before/after for a malformed multi_edit proposal', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'reject', payload: { toolCallId: 'tc1' } })
    const script: Step[] = [{ t: 'tool', toolCallId: 'tc1', name: 'multi_edit', args: { path: 'a.txt', edits: [null] } }]

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBeUndefined()
    expect(proposed.after).toBeUndefined()
  })

  it('emits no before/after when edit preview cannot match uniquely', async () => {
    const id = await newSession()
    await db.insert(controls).values({ id: randomUUID(), sessionId: id, type: 'reject', payload: { toolCallId: 'tc1' } })
    const script: Step[] = [
      {
        t: 'tool',
        toolCallId: 'tc1',
        name: 'edit_file',
        args: { path: 'a.txt', old_string: 'missing', new_string: 'replacement' },
      },
    ]

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    const proposed = events.find((e) => e.type === 'tool_proposed')!.payload as { before?: string; after?: string }
    expect(proposed.before).toBeUndefined()
    expect(proposed.after).toBeUndefined()
  })

  it('flips to awaiting-approval at a side-effecting gate, then back to running, then completed', async () => {
    const id = await newSession()
    const script: Step[] = [
      { t: 'tool', toolCallId: 'tc1', name: 'write_file', args: { path: 'gated.txt', content: 'X' } },
      { t: 'say', text: 'wrote it' },
    ]
    const p = runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
    // Poll until the run parks at the gate with the AWAITING APPROVAL pill.
    for (let i = 0; i < 100 && (await status(id)) !== 'awaiting-approval'; i++) await sleep(5)
    expect(await status(id)).toBe('awaiting-approval')
    // The write must not have executed while it waits.
    expect(await fileExists('gated.txt')).toBe(false)
    // Approve → the loop resumes (running) and finishes (completed).
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
    const script: Step[] = [{ t: 'tool', toolCallId: 'tc1', name: 'read_file', args: { path: 'a.txt' } }]
    await runSession(observingStore, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })
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
    const script: Step[] = [{ t: 'tool', toolCallId: 'todo1', name: 'todo_write', args: { items } }]

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['tool_proposed', 'tool_result', 'plan'])
    const result = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toBe('Updated plan · 3 items')
    const plan = events.find((e) => e.type === 'plan')!.payload as { items: typeof items }
    expect(plan.items).toEqual(items)
    expect(await status(id)).toBe('completed')
  })

  it('does not append a plan event when todo_write args are malformed', async () => {
    const id = await newSession()
    const script: Step[] = [
      { t: 'tool', toolCallId: 'todo1', name: 'todo_write', args: { items: [{ text: 'bad', status: 'blocked' }] } },
    ]

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['tool_proposed', 'tool_result'])
    const result = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toMatch(/^error:/)
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
    const script: Step[] = [
      { t: 'tool', toolCallId: 'r1', name: 'run_command', args: { command: 'pnpm test' } },
      { t: 'tool', toolCallId: 'r2', name: 'run_command', args: { command: 'pnpm test' } },
      { t: 'say', text: 'green' },
    ]
    const fakeRun: ToolFn = async (args) => `ran ${(args.command as string) ?? ''}`

    await runSession(observingStore, new ScriptedModel(script), id, {
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
    const script: Step[] = [
      { t: 'tool', toolCallId: 'r1', name: 'run_command', args: { command: 'pnpm test' } },
      { t: 'tool', toolCallId: 'r2', name: 'run_command', args: { command: 'pnpm test' } },
      { t: 'say', text: 'green' },
    ]
    const p = runSession(observingStore, new ScriptedModel(script), id, {
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

  it('runs an edit-test-fix-test verify loop and records the expected event order', async () => {
    const id = await newSession()
    await db.insert(controls).values([
      { id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'e1' } },
      { id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'r1', alwaysAllow: true } },
      { id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'e2' } },
    ])
    const script: Step[] = [
      {
        t: 'tool',
        toolCallId: 'e1',
        name: 'edit_file',
        args: { path: 'verify.txt', old_string: 'red', new_string: 'green' },
      },
      { t: 'tool', toolCallId: 'r1', name: 'run_command', args: { command: 'pnpm test' } },
      {
        t: 'tool',
        toolCallId: 'e2',
        name: 'edit_file',
        args: { path: 'verify.txt', old_string: 'green', new_string: 'blue' },
      },
      { t: 'tool', toolCallId: 'r2', name: 'run_command', args: { command: 'pnpm test' } },
      { t: 'say', text: 'tests pass' },
    ]
    const runResults = ['failing test output\n[exit 1]', 'passing test output\n[exit 0]']
    const fakeTools: Record<string, ToolFn> = {
      ...tools,
      edit_file: async (args) => `edited ${(args.path as string) ?? ''}`,
      run_command: async () => runResults.shift() ?? 'unexpected\n[exit 1]',
    }

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools: fakeTools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual([
      'tool_proposed',
      'tool_result',
      'tool_proposed',
      'tool_result',
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
    const script: Step[] = [{ t: 'tool', toolCallId: 'tc1', name: 'grep', args: { pattern: 'x', path: 'a.txt' } }]
    const p = runSession(store, new ScriptedModel(script), id, {
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

describe('isNoProgressRepeat', () => {
  const sev = (seq: number, type: EventType, payload: unknown): StoredEvent => ({ sessionId: 's', seq, type, payload })
  const prop = (seq: number, tcId: string, name: string, args: Record<string, unknown>): StoredEvent =>
    sev(seq, 'tool_proposed', { toolCallId: tcId, name, kind: 'read-only', args })
  const res = (seq: number, tcId: string, name: string, result: string): StoredEvent =>
    sev(seq, 'tool_result', { toolCallId: tcId, name, result })
  // n identical list_dir('.') calls that each return the same result.
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
      sev(0, 'message', { text: 'hi' }), // no toolCallId
      res(1, 'orphan', 'list_dir', 'same'), // result with no prior proposal
      sev(2, 'tool_started', { toolCallId: 'a' }), // has id but neither proposed nor result
      ...run(3),
    ]
    expect(isNoProgressRepeat(evs, same)).toBe(true)
  })
})
