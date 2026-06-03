import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions, controls, type EventType } from '@steer/schema'
import { createDb, type Db } from './db.js'
import { createDbStore, type AgentStore } from './store.js'
import { runSession, ScriptedModel, completedSteps, type Step } from './loop.js'
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
