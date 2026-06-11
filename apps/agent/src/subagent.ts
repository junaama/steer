import { classifyTool } from '@steer/schema'
import type { ModelDriver, ToolCall } from './loop.js'
import { decideTurn } from './decide.js'
import type { AgentStore, StoredEvent } from './store.js'
import type { ToolFn } from './tools/index.js'

export interface SubagentDriverInput {
  description: string
  prompt: string
  tools: string[]
}

export type SubagentDriverFactory = (input: SubagentDriverInput) => ModelDriver

export interface RunSubagentDeps {
  store: AgentStore
  sessionId: string
  parentToolCallId: string
  driver: ModelDriver
  tools: Record<string, ToolFn>
  workspaceRoot: string
  /** Sandbox boundary (broad daemon root); defaults to workspaceRoot. */
  root?: string
  homeDir?: string
  signal?: AbortSignal
  maxSteps?: number
}

export interface RunSubagentInput {
  description: string
  prompt: string
  allowedTools: string[]
}

type StopReason = 'complete' | 'cap' | 'aborted'

const DEFAULT_MAX_STEPS = 12
const TERMINAL_TYPES = new Set(['thinking', 'message', 'tool_result', 'tool_cancelled', 'tool_substituted'])

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function childEvents(events: StoredEvent[], parentToolCallId: string): StoredEvent[] {
  return events.filter((event) => {
    const payload = event.payload as { parentToolCallId?: unknown }
    return payload.parentToolCallId === parentToolCallId
  })
}

function completedChildSteps(events: StoredEvent[]): number {
  return events.filter((event) => TERMINAL_TYPES.has(event.type)).length
}

function latestChildMessage(events: StoredEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'message') return String((event.payload as { text?: unknown }).text ?? '')
  }
  return null
}

function fallbackSummary(reason: StopReason, maxSteps: number): string {
  if (reason === 'cap') return `Stopped after the ${maxSteps}-step subagent limit without finishing.`
  if (reason === 'aborted') return 'Subagent stopped because the run was aborted.'
  return 'Subagent completed without a summary.'
}

/**
 * Run a scoped child loop on the parent's tool-call tag. The child streams a turn
 * (reasoning + text deltas → coalesced thinking/message events, then a tool-call
 * batch run directly from the allowlist — no approval gate, children are already
 * bounded). The run ends when a turn proposes no tools, the step cap is hit, or
 * the parent aborts. All events are tagged with `parentToolCallId` so they fold
 * under the task call and stay out of the parent's own step cursor.
 */
export async function runSubagent(deps: RunSubagentDeps, input: RunSubagentInput): Promise<string> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const tag = { parentToolCallId: deps.parentToolCallId }
  const allowed = new Set(input.allowedTools)
  let stopReason: StopReason = 'complete'

  await deps.store.appendEvent(deps.sessionId, 'subagent_started', {
    ...tag,
    description: input.description,
    prompt: input.prompt,
  })

  runLoop: for (;;) {
    if (deps.signal?.aborted) {
      stopReason = 'aborted'
      break
    }

    const events = childEvents(await deps.store.listEvents(deps.sessionId), deps.parentToolCallId)
    const cursor = completedChildSteps(events)
    if (cursor >= maxSteps) {
      stopReason = 'cap'
      break
    }

    // Stream the child turn: deltas flush as parent-tagged delta rows, then
    // coalesce into terminal thinking/message events. Appends are SERIALIZED onto
    // one tail promise so concurrent writes never collide on the same seq.
    let deltaTail: Promise<unknown> = Promise.resolve()
    const flushDelta = (type: 'thinking_delta' | 'message_delta', chunk: string): void => {
      deltaTail = deltaTail.then(() => deps.store.appendEvent(deps.sessionId, type, { ...tag, text: chunk }))
    }
    const result = await deps.driver.next(events, cursor, {
      onReasoningDelta: (chunk) => flushDelta('thinking_delta', chunk),
      onTextDelta: (chunk) => flushDelta('message_delta', chunk),
    })
    await deltaTail

    const decision = decideTurn(events, result)
    if (decision.thinking !== undefined) {
      await deps.store.appendEvent(deps.sessionId, 'thinking', { ...tag, text: decision.thinking })
    }
    if (decision.message !== undefined) {
      await deps.store.appendEvent(deps.sessionId, 'message', { ...tag, text: decision.message })
    }
    if (decision.complete) break

    for (const call of decision.toolCalls) {
      await runChildTool(deps, tag, allowed, call)
      if (deps.signal?.aborted) {
        stopReason = 'aborted'
        break runLoop
      }
    }
  }

  const finalEvents = childEvents(await deps.store.listEvents(deps.sessionId), deps.parentToolCallId)
  const summary = latestChildMessage(finalEvents) ?? fallbackSummary(stopReason, maxSteps)
  await deps.store.appendEvent(deps.sessionId, 'subagent_result', { ...tag, summary })
  return summary
}

/** Execute one child tool call from the allowlist and record proposed → result. */
async function runChildTool(
  deps: RunSubagentDeps,
  tag: { parentToolCallId: string },
  allowed: Set<string>,
  call: ToolCall,
): Promise<void> {
  await deps.store.appendEvent(deps.sessionId, 'tool_proposed', {
    ...tag,
    toolCallId: call.toolCallId,
    name: call.name,
    kind: classifyTool(call.name),
    args: call.args,
  })

  const impl = allowed.has(call.name) ? deps.tools[call.name] : undefined
  const result = impl
    ? await impl(call.args, { workspaceRoot: deps.workspaceRoot, root: deps.root, homeDir: deps.homeDir, signal: deps.signal }).catch(
        (err: unknown) => `error: ${errorMessage(err)}`,
      )
    : `error: tool ${call.name} is not available to this subagent`

  await deps.store.appendEvent(deps.sessionId, 'tool_result', {
    ...tag,
    toolCallId: call.toolCallId,
    name: call.name,
    result,
  })
}
