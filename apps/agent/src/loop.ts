import { classifyTool } from '@steer/schema'
import type { AgentStore, StoredEvent } from './store.js'
import type { ToolFn } from './tools/index.js'
import { resolveTool } from './intercept.js'

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

/**
 * The completed-step count is derived from the event log: each step ends in
 * exactly one terminal event. On restart, recomputing this resumes from the last
 * committed step without re-running committed work (crash-only resume).
 */
export function completedSteps(events: StoredEvent[]): number {
  return events.filter((e) => TERMINAL_TYPES.has(e.type)).length
}

export interface RunOptions {
  workspaceRoot: string
  tools: Record<string, ToolFn>
  signal?: AbortSignal
  /** Control-poll interval for the approval gate + live cancel (ms). */
  pollMs?: number
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
    const cursor = completedSteps(events)
    const step = await driver.next(events, cursor)

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
    await store.appendEvent(sessionId, 'tool_proposed', {
      toolCallId: step.toolCallId,
      name: step.name,
      kind: classifyTool(step.name),
      args: step.args,
    })
    const outcome = await resolveTool(store, sessionId, step, {
      tools: options.tools,
      workspaceRoot: options.workspaceRoot,
      pollMs: options.pollMs ?? 200,
      signal: options.signal,
    })
    if (outcome === 'interrupted') {
      const events = await store.listEvents(sessionId)
      const atSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
      await store.appendEvent(sessionId, 'interrupted', { atSeq })
      await store.setStatus(sessionId, 'interrupted')
      return
    }
  }
}
