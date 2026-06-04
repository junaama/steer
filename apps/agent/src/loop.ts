import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyTool, validateToolArgs } from '@steer/schema'
import type { AgentStore, StoredEvent } from './store.js'
import type { ToolFn } from './tools/index.js'
import type { SubagentDriverFactory } from './subagent.js'
import { applyEdits, type Edit } from './tools/edit.js'
import { resolveTool } from './intercept.js'

async function readBefore(root: string, path: string): Promise<string> {
  try {
    return await readFile(join(root, path), 'utf8')
  } catch {
    return ''
  }
}

const FILE_MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit'])
const PLAN_TOOL = 'todo_write'

async function fileMutationPreview(root: string, name: string, args: Record<string, unknown>): Promise<
  { before: string; after: string } | undefined
> {
  if (!FILE_MUTATING_TOOLS.has(name) || typeof args.path !== 'string') return undefined
  const before = await readBefore(root, args.path)
  try {
    if (name === 'write_file') return { before, after: String(args.content ?? '') }
    if (name === 'edit_file' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
      return { before, after: applyEdits(before, [{ old_string: args.old_string, new_string: args.new_string }]) }
    }
    if (name === 'multi_edit' && Array.isArray(args.edits)) {
      const edits = args.edits.map((edit): Edit | undefined => {
        if (
          typeof edit === 'object' &&
          edit !== null &&
          'old_string' in edit &&
          'new_string' in edit &&
          typeof edit.old_string === 'string' &&
          typeof edit.new_string === 'string'
        ) {
          return { old_string: edit.old_string, new_string: edit.new_string }
        }
        return undefined
      })
      if (!edits.every((edit): edit is Edit => edit !== undefined)) return undefined
      return { before, after: applyEdits(before, edits) }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** One scripted step the model driver yields. Mirrors the real LLM's turn shapes. */
export type Step =
  | { t: 'thinking'; text: string }
  | { t: 'say'; text: string }
  | { t: 'tool'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { t: 'complete' }

export interface ModelDriver {
  /** Produce the next step given the persisted events and the completed-step cursor. */
  next(events: StoredEvent[], cursor: number): Promise<Step>
}

/** Deterministic driver for tests — advances purely by the cursor derived from the log. */
export class ScriptedModel implements ModelDriver {
  constructor(
    private readonly script: Step[],
    private readonly opts: { failAtCursor?: number } = {},
  ) {}

  async next(_events: StoredEvent[], cursor: number): Promise<Step> {
    if (this.opts.failAtCursor !== undefined && cursor === this.opts.failAtCursor) {
      throw new Error('simulated crash')
    }
    return this.script[cursor] ?? { t: 'complete' }
  }
}

const TERMINAL_TYPES = new Set(['thinking', 'message', 'tool_result', 'tool_cancelled', 'tool_substituted'])
const DEFAULT_MAX_STEPS = 80

/**
 * The completed-step count is derived from the event log: each step ends in
 * exactly one terminal event. On restart, recomputing this resumes from the last
 * committed step without re-running committed work (crash-only resume).
 */
export function completedSteps(events: StoredEvent[]): number {
  return events.filter((e) => TERMINAL_TYPES.has(e.type)).length
}

function parentEvents(events: StoredEvent[]): StoredEvent[] {
  return events.filter((event) => {
    const payload = event.payload as { parentToolCallId?: unknown }
    return typeof payload.parentToolCallId !== 'string'
  })
}

export interface RunOptions {
  workspaceRoot: string
  tools: Record<string, ToolFn>
  signal?: AbortSignal
  /** Control-poll interval for the approval gate + live cancel (ms). */
  pollMs?: number
  /** Safety ceiling on completed steps before a run is force-stopped (default 80). */
  maxSteps?: number
  /** Factory for in-process child loops used by the task tool. */
  subagentDriver?: SubagentDriverFactory
}

/**
 * Run a session to completion (or until interrupted). The agent keeps no private
 * state — everything is read from / appended to the synced event log, so a crash
 * mid-run resumes from the log on the next call.
 */
export async function runSession(
  store: AgentStore,
  driver: ModelDriver,
  sessionId: string,
  options: RunOptions,
): Promise<void> {
  await store.setStatus(sessionId, 'running')
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const allowlist = new Set<string>()

  for (;;) {
    // Operator interrupt halts at the step boundary (control-plane-via-data-plane).
    const pending = await store.listUnconsumedControls(sessionId)
    const interrupt = pending.find((c) => c.type === 'interrupt')
    if (interrupt) {
      await store.consumeControl(interrupt.id)
      const events = await store.listEvents(sessionId)
      const atSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
      await store.appendEvent(sessionId, 'interrupted', { atSeq })
      await store.setStatus(sessionId, 'interrupted')
      return
    }

    const events = await store.listEvents(sessionId)
    const visibleEvents = parentEvents(events)
    const cursor = completedSteps(visibleEvents)
    // Safety ceiling: stop a model that loops without finishing (e.g. repeating a
    // tool that yields nothing) instead of burning unbounded inference calls.
    if (cursor >= maxSteps) {
      await store.appendEvent(sessionId, 'message', {
        text: `Stopped after the ${maxSteps}-step safety limit without finishing. Narrow the task or raise STEER_MAX_STEPS.`,
      })
      await store.setStatus(sessionId, 'error')
      return
    }
    const step = await driver.next(visibleEvents, cursor)

    if (step.t === 'complete') {
      await store.setStatus(sessionId, 'completed')
      return
    }
    if (step.t === 'thinking') {
      await store.appendEvent(sessionId, 'thinking', { text: step.text })
      continue
    }
    if (step.t === 'say') {
      await store.appendEvent(sessionId, 'message', { text: step.text })
      continue
    }

    // Tool step — interception: U8 approval gate, U9 override, U10 live cancel.
    const kind = classifyTool(step.name)
    const proposed: Record<string, unknown> = {
      toolCallId: step.toolCallId,
      name: step.name,
      kind,
      args: step.args,
    }
    // Emit before/after for file-mutating tools so the UI can render a diff.
    const preview = await fileMutationPreview(options.workspaceRoot, step.name, step.args)
    if (preview) Object.assign(proposed, preview)
    await store.appendEvent(sessionId, 'tool_proposed', proposed)
    // A side-effecting tool blocks at the approval gate — flip the session pill to
    // AWAITING APPROVAL while it waits so the operator sees it needs a decision
    // (the interrupt path below owns 'interrupted', so don't reset that case).
    const gated = kind === 'side-effecting' && !allowlist.has(step.name)
    if (gated) await store.setStatus(sessionId, 'awaiting-approval')
    const outcome = await resolveTool(store, sessionId, step, {
      tools: options.tools,
      workspaceRoot: options.workspaceRoot,
      pollMs: options.pollMs ?? 200,
      allowlist,
      signal: options.signal,
      subagentDriver: options.subagentDriver,
      maxSteps,
    })
    if (outcome === 'interrupted') {
      const events = await store.listEvents(sessionId)
      const atSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
      await store.appendEvent(sessionId, 'interrupted', { atSeq })
      await store.setStatus(sessionId, 'interrupted')
      return
    }
    if (step.name === PLAN_TOOL) {
      const afterTool = await store.listEvents(sessionId)
      const terminal = [...afterTool].reverse().find((event) => {
        const payload = event.payload as { toolCallId?: unknown; name?: unknown }
        return payload.toolCallId === step.toolCallId && payload.name === PLAN_TOOL
      })
      if (terminal?.type === 'tool_result') {
        try {
          const { items } = validateToolArgs(PLAN_TOOL, step.args) as {
            items: { text: string; status: 'pending' | 'in_progress' | 'done' }[]
          }
          await store.appendEvent(sessionId, 'plan', { items })
        } catch {
          // The tool_result already records the validation error; malformed args
          // must not become the durable current plan.
        }
      }
    }
    if (gated) await store.setStatus(sessionId, 'running')
  }
}
