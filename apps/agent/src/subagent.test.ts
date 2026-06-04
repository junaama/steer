import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { mkdtemp, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions, controls, READ_ONLY_TOOLS, type EventType } from '@steer/schema'
import { createDb, type Db } from './db.js'
import { createDbStore, type AgentStore } from './store.js'
import { runSession, ScriptedModel, type ModelDriver, type Step } from './loop.js'
import { runSubagent, type SubagentDriverInput } from './subagent.js'
import { tools, type ToolFn } from './tools/index.js'

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://steer:steer@localhost:54321/steer?sslmode=disable'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let pool: pg.Pool
let db: Db
let store: AgentStore
let workspace: string

async function newSession(): Promise<string> {
  const id = randomUUID()
  await db.insert(sessions).values({ id, userId: 'u1', title: 'task', lastStatus: 'starting' })
  return id
}

async function approveTask(sessionId: string, toolCallId: string): Promise<void> {
  await db.insert(controls).values({ id: randomUUID(), sessionId, type: 'approve', payload: { toolCallId } })
}

function types(events: { type: EventType }[]): EventType[] {
  return events.map((event) => event.type)
}

function parentId(payload: unknown): string | undefined {
  const value = (payload as { parentToolCallId?: unknown }).parentToolCallId
  return typeof value === 'string' ? value : undefined
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
  workspace = await mkdtemp(join(tmpdir(), 'steer-subagent-'))
  await writeFile(join(workspace, 'a.txt'), 'hello\nworld')
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE sessions CASCADE;')
})

describe('task subagent integration', () => {
  it('records child steps under the task call and returns the child summary as the parent tool_result', async () => {
    const id = await newSession()
    await approveTask(id, 'task1')
    const childInputs: SubagentDriverInput[] = []
    const childScript: Step[] = [
      { t: 'tool', toolCallId: 'child-read', name: 'read_file', args: { path: 'a.txt' } },
      { t: 'say', text: 'done' },
    ]
    const subagentDriver = (input: SubagentDriverInput): ModelDriver => {
      childInputs.push(input)
      return new ScriptedModel(childScript)
    }
    const parentScript: Step[] = [
      {
        t: 'tool',
        toolCallId: 'task1',
        name: 'task',
        args: { description: 'Inspect a file', prompt: 'Read a.txt and summarize it' },
      },
      { t: 'say', text: 'parent saw done' },
    ]

    await runSession(store, new ScriptedModel(parentScript), id, {
      workspaceRoot: workspace,
      tools,
      pollMs: 5,
      subagentDriver,
    })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual([
      'tool_proposed',
      'subagent_started',
      'tool_proposed',
      'tool_result',
      'message',
      'subagent_result',
      'tool_result',
      'message',
    ])
    expect(childInputs).toEqual([
      {
        description: 'Inspect a file',
        prompt: 'Read a.txt and summarize it',
        tools: READ_ONLY_TOOLS,
      },
    ])

    const childEvents = events.filter((event) => parentId(event.payload) === 'task1')
    expect(types(childEvents)).toEqual(['subagent_started', 'tool_proposed', 'tool_result', 'message', 'subagent_result'])
    const childToolResult = childEvents.find((event) => event.type === 'tool_result')!.payload as { result: string }
    expect(childToolResult.result).toContain('hello')

    const parentToolResult = events.find((event) => {
      const payload = event.payload as { toolCallId?: unknown; parentToolCallId?: unknown }
      return event.type === 'tool_result' && payload.toolCallId === 'task1' && payload.parentToolCallId === undefined
    })!.payload as { result: string }
    expect(parentToolResult.result).toBe('done')

    const parentMessage = events.find((event) => {
      const payload = event.payload as { text?: unknown; parentToolCallId?: unknown }
      return event.type === 'message' && payload.text === 'parent saw done' && payload.parentToolCallId === undefined
    })
    expect(parentMessage).toBeDefined()
  })

  it('prevents a child from executing a tool outside the task tool allowlist', async () => {
    const id = await newSession()
    await approveTask(id, 'task2')
    const subagentDriver = (): ModelDriver =>
      new ScriptedModel([
        { t: 'tool', toolCallId: 'child-write', name: 'write_file', args: { path: 'blocked.txt', content: 'nope' } },
        { t: 'say', text: 'done' },
      ])
    const parentScript: Step[] = [
      {
        t: 'tool',
        toolCallId: 'task2',
        name: 'task',
        args: { description: 'Try a write', prompt: 'Write a file', tools: ['read_file'] },
      },
    ]

    await runSession(store, new ScriptedModel(parentScript), id, {
      workspaceRoot: workspace,
      tools,
      pollMs: 5,
      subagentDriver,
    })

    expect(await fileExists('blocked.txt')).toBe(false)
    const childResult = (await store.listEvents(id)).find((event) => {
      const payload = event.payload as { toolCallId?: unknown; parentToolCallId?: unknown }
      return event.type === 'tool_result' && payload.toolCallId === 'child-write' && payload.parentToolCallId === 'task2'
    })!.payload as { result: string }
    expect(childResult.result).toBe('error: tool write_file is not available to this subagent')
  })
})

describe('runSubagent', () => {
  it('returns a fallback summary when the child completes without a message', async () => {
    const id = await newSession()

    const summary = await runSubagent(
      {
        store,
        sessionId: id,
        parentToolCallId: 'task-empty',
        driver: new ScriptedModel([]),
        tools,
        workspaceRoot: workspace,
      },
      { description: 'Empty', prompt: 'Finish immediately', allowedTools: [] },
    )

    expect(summary).toBe('Subagent completed without a summary.')
    expect(types(await store.listEvents(id))).toEqual(['subagent_started', 'subagent_result'])
  })

  it('stops a non-terminating child at the child step cap', async () => {
    const id = await newSession()
    const looping: ModelDriver = { next: async () => ({ t: 'thinking', text: 'still going' }) }

    const summary = await runSubagent(
      {
        store,
        sessionId: id,
        parentToolCallId: 'task-cap',
        driver: looping,
        tools,
        workspaceRoot: workspace,
        maxSteps: 2,
      },
      { description: 'Loop', prompt: 'Never stop', allowedTools: [] },
    )

    expect(summary).toBe('Stopped after the 2-step subagent limit without finishing.')
    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['subagent_started', 'thinking', 'thinking', 'subagent_result'])
  })

  it('propagates parent abort signals into the child loop and stops before another child step', async () => {
    const id = await newSession()
    const ac = new AbortController()
    const cursors: number[] = []
    const driver: ModelDriver = {
      next: async (_events, cursor) => {
        cursors.push(cursor)
        return { t: 'tool', toolCallId: 'slow-read', name: 'read_file', args: { path: 'a.txt' } }
      },
    }
    const slowRead: ToolFn = (_args, ctx) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve('late'), 500)
        ctx.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })

    const run = runSubagent(
      {
        store,
        sessionId: id,
        parentToolCallId: 'task-abort',
        driver,
        tools: { read_file: slowRead },
        workspaceRoot: workspace,
        signal: ac.signal,
        maxSteps: 5,
      },
      { description: 'Abort', prompt: 'Read slowly', allowedTools: ['read_file'] },
    )
    await sleep(20)
    ac.abort()

    await expect(run).resolves.toBe('Subagent stopped because the run was aborted.')
    expect(cursors).toEqual([0])
    const events = await store.listEvents(id)
    expect(types(events)).toEqual(['subagent_started', 'tool_proposed', 'tool_result', 'subagent_result'])
    const result = events.find((event) => event.type === 'tool_result')!.payload as { result: string }
    expect(result.result).toBe('error: aborted')
  })

  it('stops before the first child step when the parent signal is already aborted', async () => {
    const id = await newSession()
    const ac = new AbortController()
    ac.abort()

    const summary = await runSubagent(
      {
        store,
        sessionId: id,
        parentToolCallId: 'task-pre-abort',
        driver: new ScriptedModel([{ t: 'say', text: 'should not run' }]),
        tools,
        workspaceRoot: workspace,
        signal: ac.signal,
      },
      { description: 'Abort early', prompt: 'Do nothing', allowedTools: [] },
    )

    expect(summary).toBe('Subagent stopped because the run was aborted.')
    expect(types(await store.listEvents(id))).toEqual(['subagent_started', 'subagent_result'])
  })
})
