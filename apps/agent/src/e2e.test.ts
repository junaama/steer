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
import { runSession, ScriptedModel, type Step } from './loop.js'
import { tools } from './tools/index.js'

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://steer:steer@localhost:54321/steer?sslmode=disable'

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

function payloadFor<T extends Record<string, unknown>>(events: StoredEvent[], type: EventType, toolCallId: string): T {
  const event = events.find((candidate) => {
    const payload = candidate.payload as { toolCallId?: unknown }
    return candidate.type === type && payload.toolCallId === toolCallId
  })
  expect(event).toBeDefined()
  return event!.payload as T
}

beforeAll(async () => {
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
  await writeFile(join(workspace, 'verify.txt'), 'status=red\n')
})

describe('coding-agent capstone integration', () => {
  it('records a full self-verify session from the DB event log', async () => {
    const id = await newSession()
    const statusTransitions: string[] = []
    const observingStore: AgentStore = {
      ...store,
      async setStatus(sessionId, status) {
        statusTransitions.push(status)
        return store.setStatus(sessionId, status)
      },
    }
    await db.insert(controls).values([
      { id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'e1' } },
      { id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'r1', alwaysAllow: true } },
      { id: randomUUID(), sessionId: id, type: 'approve', payload: { toolCallId: 'e2' } },
    ])
    const planItems = [
      { text: 'make the first fix', status: 'done' },
      { text: 'run verification', status: 'in_progress' },
      { text: 'ship after green', status: 'pending' },
    ]
    const failingCommand = `node -e "process.stdout.write('failing test output'); process.exit(1)"`
    const passingCommand = `node -e "process.stdout.write('passing test output')"`
    const script: Step[] = [
      { t: 'tool', toolCallId: 'todo1', name: 'todo_write', args: { items: planItems } },
      {
        t: 'tool',
        toolCallId: 'e1',
        name: 'edit_file',
        args: { path: 'verify.txt', old_string: 'status=red', new_string: 'status=yellow' },
      },
      { t: 'tool', toolCallId: 'r1', name: 'run_command', args: { command: failingCommand } },
      {
        t: 'tool',
        toolCallId: 'e2',
        name: 'edit_file',
        args: { path: 'verify.txt', old_string: 'status=yellow', new_string: 'status=green' },
      },
      { t: 'tool', toolCallId: 'r2', name: 'run_command', args: { command: passingCommand } },
      { t: 'say', text: 'self-verify complete' },
    ]

    await runSession(observingStore, new ScriptedModel(script), id, { workspaceRoot: workspace, tools, pollMs: 5 })

    const events = await store.listEvents(id)
    expect(types(events)).toEqual([
      'tool_proposed',
      'tool_result',
      'plan',
      'tool_proposed',
      'tool_result',
      'tool_proposed',
      'tool_result',
      'tool_proposed',
      'tool_result',
      'tool_proposed',
      'tool_result',
      'message',
      // Completion reconciles the plan so the artifact can't read as unfinished.
      'plan',
    ])

    const planEvents = events.filter((event) => event.type === 'plan')
    const plan = planEvents[0]!.payload as { items: typeof planItems }
    expect(plan.items).toEqual(planItems) // the first plan mirrors the tool args verbatim
    // The completed session's final plan has every item done — the synced artifact
    // matches the Complete status instead of showing stale in-progress/pending todos.
    const finalPlan = planEvents.at(-1)!.payload as { items: typeof planItems }
    expect(finalPlan.items).toEqual([
      { text: 'make the first fix', status: 'done' },
      { text: 'run verification', status: 'done' },
      { text: 'ship after green', status: 'done' },
    ])

    const firstEdit = payloadFor<{ before: string; after: string }>(events, 'tool_proposed', 'e1')
    expect(firstEdit.before).toBe('status=red\n')
    expect(firstEdit.after).toBe('status=yellow\n')
    const secondEdit = payloadFor<{ before: string; after: string }>(events, 'tool_proposed', 'e2')
    expect(secondEdit.before).toBe('status=yellow\n')
    expect(secondEdit.after).toBe('status=green\n')

    const firstRun = payloadFor<{ result: string }>(events, 'tool_result', 'r1')
    expect(firstRun.result).toBe('failing test output\n[exit 1]')
    const secondRun = payloadFor<{ result: string }>(events, 'tool_result', 'r2')
    expect(secondRun.result).toBe('passing test output\n[exit 0]')
    expect(statusTransitions.filter((status) => status === 'awaiting-approval')).toHaveLength(3)

    const message = events.find((event) => event.type === 'message')!.payload as { text: string }
    expect(message.text).toBe('self-verify complete')
    expect(await readFile(join(workspace, 'verify.txt'), 'utf8')).toBe('status=green\n')
    expect(await sessionStatus(id)).toBe('completed')
  })
})
