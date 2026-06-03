import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { mkdtemp, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions, controls, type ControlType, type EventType } from '@steer/schema'
import { createDb, type Db } from './db.js'
import { createDbStore, type AgentStore } from './store.js'
import { resolveTool, type ToolStep } from './intercept.js'
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
  await db.insert(sessions).values({ id, userId: 'u1', title: 't', lastStatus: 'running' })
  return id
}
async function addControl(sessionId: string, type: ControlType, payload: Record<string, unknown>): Promise<void> {
  await db.insert(controls).values({ id: randomUUID(), sessionId, type, payload })
}
async function types(id: string): Promise<EventType[]> {
  return (await store.listEvents(id)).map((e) => e.type)
}
async function fileExists(name: string): Promise<boolean> {
  return access(join(workspace, name)).then(
    () => true,
    () => false,
  )
}

// A read-only tool slow enough to be cancelled mid-flight; respects AbortSignal.
const slowRead: ToolFn = (_args, ctx) =>
  new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => resolve('SLOW RESULT'), 500)
    ctx.signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL })
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  db = createDb(pool)
  await migrate(db, { migrationsFolder: '../server/drizzle' })
  store = createDbStore(db)
  workspace = await mkdtemp(join(tmpdir(), 'steer-intercept-'))
  await writeFile(join(workspace, 'a.txt'), 'hello\nworld')
})
afterAll(async () => {
  await pool.end()
})
beforeEach(async () => {
  await pool.query('TRUNCATE sessions CASCADE;')
})

const base = { tools, workspaceRoot: '', pollMs: 5 }

describe('U8 approval gate (side-effecting tools)', () => {
  it('executes write_file only after approval', async () => {
    const id = await newSession()
    await addControl(id, 'approve', { toolCallId: 'w1' })
    const step: ToolStep = { toolCallId: 'w1', name: 'write_file', args: { path: 'approved.txt', content: 'X' } }
    const r = await resolveTool(store, id, step, { ...base, workspaceRoot: workspace })
    expect(r).toBe('resolved')
    expect(await types(id)).toEqual(['tool_result'])
    expect(await fileExists('approved.txt')).toBe(true)
  })

  it('does not execute a rejected write (tool_cancelled, file untouched)', async () => {
    const id = await newSession()
    await addControl(id, 'reject', { toolCallId: 'w1' })
    const step: ToolStep = { toolCallId: 'w1', name: 'write_file', args: { path: 'rejected.txt', content: 'X' } }
    await resolveTool(store, id, step, { ...base, workspaceRoot: workspace })
    expect(await types(id)).toEqual(['tool_cancelled'])
    expect(await fileExists('rejected.txt')).toBe(false)
  })

  it('holds at the gate with no execution until a decision arrives', async () => {
    const id = await newSession()
    const ac = new AbortController()
    const step: ToolStep = { toolCallId: 'w1', name: 'write_file', args: { path: 'gate.txt', content: 'X' } }
    let resolved = false
    const p = resolveTool(store, id, step, { ...base, workspaceRoot: workspace, signal: ac.signal }).then(() => {
      resolved = true
    })
    await sleep(40)
    expect(resolved).toBe(false)
    expect(await fileExists('gate.txt')).toBe(false)
    ac.abort() // daemon shutdown lets the gate exit
    await p
    expect(await fileExists('gate.txt')).toBe(false)
  })
})

describe('U9 override engine + audit', () => {
  it('substitutes a read-only tool and records the audit', async () => {
    const id = await newSession()
    await addControl(id, 'override', { toolCallId: 'tc1', newTool: 'read_file', newArgs: { path: 'a.txt' } })
    const step: ToolStep = { toolCallId: 'tc1', name: 'grep', args: { pattern: 'x', path: 'a.txt' } }
    await resolveTool(store, id, step, { ...base, workspaceRoot: workspace })
    const events = await store.listEvents(id)
    expect(events.map((e) => e.type)).toEqual(['tool_substituted'])
    const p = events[0]!.payload as { name: string; from: string; result: string }
    expect(p.name).toBe('read_file')
    expect(p.from).toBe('grep')
    expect(p.result).toContain('hello')
  })

  it('runs the tool with edited args', async () => {
    const id = await newSession()
    await addControl(id, 'override', { toolCallId: 'tc1', newArgs: { path: 'a.txt' } })
    const step: ToolStep = { toolCallId: 'tc1', name: 'read_file', args: { path: 'nonexistent.txt' } }
    await resolveTool(store, id, step, { ...base, workspaceRoot: workspace })
    const events = await store.listEvents(id)
    expect(events.map((e) => e.type)).toEqual(['tool_result'])
    expect((events[0]!.payload as { result: string }).result).toContain('hello')
  })
})

describe('U10 live cancel-and-substitute (read-only)', () => {
  it('cancels an in-flight read-only tool and discards partial output', async () => {
    const id = await newSession()
    await addControl(id, 'reject', { toolCallId: 'tc1' })
    const step: ToolStep = { toolCallId: 'tc1', name: 'grep', args: { pattern: 'x', path: 'a.txt' } }
    await resolveTool(store, id, step, { tools: { ...tools, grep: slowRead }, workspaceRoot: workspace, pollMs: 5 })
    const events = await store.listEvents(id)
    expect(events.map((e) => e.type)).toEqual(['tool_cancelled'])
    expect(JSON.stringify(events)).not.toContain('SLOW RESULT')
  })

  it('swaps an in-flight read-only tool for another via override', async () => {
    const id = await newSession()
    await addControl(id, 'override', { toolCallId: 'tc1', newTool: 'read_file', newArgs: { path: 'a.txt' } })
    const step: ToolStep = { toolCallId: 'tc1', name: 'grep', args: { pattern: 'x', path: 'a.txt' } }
    await resolveTool(store, id, step, { tools: { ...tools, grep: slowRead }, workspaceRoot: workspace, pollMs: 5 })
    const events = await store.listEvents(id)
    expect(events.map((e) => e.type)).toEqual(['tool_substituted'])
    expect((events[0]!.payload as { result: string }).result).toContain('hello')
  })

  it('returns the result when the tool finishes before any control', async () => {
    const id = await newSession()
    const step: ToolStep = { toolCallId: 'tc1', name: 'grep', args: { pattern: 'hello', path: 'a.txt' } }
    await resolveTool(store, id, step, { ...base, workspaceRoot: workspace })
    const events = await store.listEvents(id)
    expect(events.map((e) => e.type)).toEqual(['tool_result'])
    expect((events[0]!.payload as { result: string }).result).toContain('a.txt')
  })
})
