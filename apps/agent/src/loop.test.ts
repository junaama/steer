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
import { runSession, ScriptedModel, completedSteps, isNoProgressRepeat, findCachedWebFetch, latestPlan, planMarkedAllDone, type Step, type ModelDriver } from './loop.js'
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

  it('stops a varied-but-fruitless search (grep, changing args, identical "no matches") before the cap', async () => {
    const id = await newSession()
    // The grep thrash that walked the step cap on a real SWE-bench instance: the
    // same search tool with a fresh non-matching pattern each step, so every
    // (name+args) key differs but every result is the identical "— no matches".
    // The exact-repeat rule misses this; the search-thrash rule must still stop it.
    let n = 0
    const thrash: ModelDriver = {
      next: async () => ({ t: 'tool', toolCallId: `tc${n}`, name: 'grep', args: { pattern: `zzz${n++}`, path: 'a.txt' } }),
    }
    await runSession(store, thrash, id, { workspaceRoot: workspace, tools, maxSteps: 80 })

    const events = await store.listEvents(id)
    const results = events.filter((e) => e.type === 'tool_result')
    expect(results).toHaveLength(3) // REPEAT_LIMIT, not 80 — bounded despite varied args
    expect((results[0]!.payload as { result: string }).result).toBe('— no matches')
    const msg = events.filter((e) => e.type === 'message').at(-1)!.payload as { text: string }
    expect(msg.text).toContain('grep')
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
    // todo_write records a tool_result + a plan event mirroring its args; the run
    // then completes, which appends a reconciling plan (every item marked done).
    expect(types(events)).toEqual(['tool_proposed', 'tool_result', 'plan', 'plan'])
    const result = events.find((e) => e.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toBe('Updated plan · 3 items')
    const plan = events.find((e) => e.type === 'plan')!.payload as { items: typeof items }
    expect(plan.items).toEqual(items) // the first plan mirrors the tool args verbatim
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

  it('marks every open plan item done when the run completes, so the plan matches Complete', async () => {
    const id = await newSession()
    // A plan the model never finishes flipping to done — the drift the ticket describes.
    const items = [
      { text: 'write schema tests', status: 'done' },
      { text: 'wire agent loop', status: 'in_progress' },
      { text: 'render todo panel', status: 'pending' },
    ]
    const script: Step[] = [{ t: 'tool', toolCallId: 'todo1', name: 'todo_write', args: { items } }]

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    // The original plan, then a reconciling plan appended on completion.
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
    const script: Step[] = [{ t: 'tool', toolCallId: 'todo1', name: 'todo_write', args: { items } }]

    await runSession(store, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(events.filter((e) => e.type === 'plan')).toHaveLength(1)
    expect(await status(id)).toBe('completed')
  })

  it('leaves an unfinished plan untouched when the run errors out instead of completing', async () => {
    const id = await newSession()
    // Establish a plan, then keep proposing the same no-op call so the loop stops
    // on the no-progress guard (status 'error') rather than reaching 'complete'.
    const items = [{ text: 'keep going', status: 'in_progress' }]
    let n = 0
    const stuck: ModelDriver = {
      next: async () => {
        if (n++ === 0) return { t: 'tool', toolCallId: 'todo1', name: 'todo_write', args: { items } }
        // Re-propose the same read until the no-progress guard force-stops with 'error'.
        return { t: 'tool', toolCallId: `r${n}`, name: 'read_file', args: { path: 'a.txt' } }
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

  // Varied-but-fruitless search: the same search tool over DIFFERENT args that
  // each come back with the identical fruitless result. The exact-repeat rule
  // misses this because every (name+args) key differs; this is the grep thrash
  // that walked the step cap (29 greps for "content-length", all "— no matches").
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
    // Identical content from 3 different read_file paths is not the fruitless-search
    // failure mode; only the exact-repeat rule applies to non-search tools.
    const reads = fruitlessSearch('read_file', [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }], 'X')
    expect(isNoProgressRepeat(reads, { name: 'read_file', args: { path: 'd.ts' } })).toBe(false)
    // list_dir is deliberately excluded: switching to a new dir is real exploration.
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

    // The model calls web_fetch on the same URL twice; the second call should
    // hit the cache and succeed rather than triggering the repeat guard.
    const script: Step[] = [
      { t: 'tool', toolCallId: 'wf1', name: 'web_fetch', args: { url: fetchUrl } },
      { t: 'tool', toolCallId: 'wf2', name: 'web_fetch', args: { url: fetchUrl } },
      { t: 'say', text: 'done' },
    ]

    await runSession(store, new ScriptedModel(script), id, {
      workspaceRoot: workspace,
      tools: { ...tools, web_fetch: fakeFetch },
    })

    const events = await store.listEvents(id)
    // Both calls produce a tool_proposed + tool_result; session completes (not error).
    expect(events.filter((e) => e.type === 'tool_proposed')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2)
    const results = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e.payload as { result: string }).result)
    // Both results are the cached content string.
    expect(results[0]).toBe(`content of ${fetchUrl}`)
    expect(results[1]).toBe(`content of ${fetchUrl}`)
    expect(await status(id)).toBe('completed')
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
