import { classifyTool } from '@steer/schema'
import type { AgentStore, StoredControl } from './store.js'
import type { ToolFn } from './tools/index.js'
import type { SubagentDriverFactory } from './subagent.js'

export interface ToolStep {
  toolCallId: string
  name: string
  args: Record<string, unknown>
}

export interface ResolveDeps {
  tools: Record<string, ToolFn>
  workspaceRoot: string
  pollMs: number
  /** Per-session tool-name grants from approve controls carrying alwaysAllow. */
  allowlist?: Set<string>
  /** Run-level abort (daemon shutdown) — lets a waiting gate exit cleanly. */
  signal?: AbortSignal
  /** Factory for scoped child model drivers used by the task tool. */
  subagentDriver?: SubagentDriverFactory
  /** Child-loop safety ceiling passed through to task subagents. */
  maxSteps?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function findInterrupt(controls: StoredControl[]): StoredControl | undefined {
  return controls.find((c) => c.type === 'interrupt')
}

function findToolControl(controls: StoredControl[], toolCallId: string): StoredControl | undefined {
  return controls.find((c) => {
    if (c.type === 'interrupt') return false
    const payload = c.payload as { toolCallId?: string }
    return payload.toolCallId === toolCallId
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Resolve a single tool step with interception.
 *
 * - U8: side-effecting tools wait at an approval gate (no execution until a
 *   decision control arrives).
 * - U9: an override control substitutes a (read-only) tool or edits args; the
 *   event log records proposed → override → executed for audit.
 * - U10: read-only tools run immediately under a cancellable wrapper; a control
 *   aborts the in-flight tool, discards partial output, and applies the override.
 *
 * Returns 'interrupted' if an interrupt control arrives (the loop then halts).
 */
export async function resolveTool(
  store: AgentStore,
  sessionId: string,
  step: ToolStep,
  deps: ResolveDeps,
): Promise<'resolved' | 'interrupted'> {
  const kind = classifyTool(step.name)

  const runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const impl = deps.tools[name]
    if (!impl) return `error: unknown tool ${name}`
    const subagent =
      name === 'task' && deps.subagentDriver
        ? {
            store,
            sessionId,
            parentToolCallId: step.toolCallId,
            driverFor: deps.subagentDriver,
            tools: deps.tools,
            maxSteps: deps.maxSteps,
          }
        : undefined
    try {
      return await impl(args, { workspaceRoot: deps.workspaceRoot, signal: deps.signal, subagent })
    } catch (err) {
      return `error: ${errorMessage(err)}`
    }
  }

  const applyControl = async (control: StoredControl): Promise<'resolved'> => {
    await store.consumeControl(control.id)
    if (control.type === 'reject') {
      await store.appendEvent(sessionId, 'tool_cancelled', {
        toolCallId: step.toolCallId,
        name: step.name,
        reason: kind === 'side-effecting' ? 'rejected by operator — not executed' : 'cancelled by operator',
      })
      return 'resolved'
    }
    if (control.type === 'override') {
      const payload = control.payload as { newTool?: string; newArgs?: Record<string, unknown> }
      if (payload.newTool) {
        const result = await runTool(payload.newTool, payload.newArgs ?? {})
        await store.appendEvent(sessionId, 'tool_substituted', {
          toolCallId: step.toolCallId,
          name: payload.newTool,
          from: step.name,
          result,
        })
      } else {
        // Same tool, operator-edited args — mark the result for the audit line.
        const result = await runTool(step.name, payload.newArgs ?? step.args)
        await store.appendEvent(sessionId, 'tool_result', {
          toolCallId: step.toolCallId,
          name: step.name,
          result,
          edited: true,
        })
      }
      return 'resolved'
    }
    // approve → execute as proposed; alwaysAllow grants this tool name for the
    // rest of the in-memory session run.
    const payload = control.payload as { alwaysAllow?: boolean }
    if (payload.alwaysAllow === true) deps.allowlist?.add(step.name)
    const result = await runTool(step.name, step.args)
    await store.appendEvent(sessionId, 'tool_result', { toolCallId: step.toolCallId, name: step.name, result })
    return 'resolved'
  }

  // U8: approval gate for side-effecting tools.
  if (kind === 'side-effecting') {
    if (deps.allowlist?.has(step.name)) {
      const result = await runTool(step.name, step.args)
      await store.appendEvent(sessionId, 'tool_result', { toolCallId: step.toolCallId, name: step.name, result })
      return 'resolved'
    }

    for (;;) {
      if (deps.signal?.aborted) return 'resolved'
      const controls = await store.listUnconsumedControls(sessionId)
      if (findInterrupt(controls)) return 'interrupted'
      const decision = findToolControl(controls, step.toolCallId)
      if (decision) return applyControl(decision)
      await sleep(deps.pollMs)
    }
  }

  // U10: read-only tools run live under a cancellable wrapper.
  const ac = new AbortController()
  const impl = deps.tools[step.name]
  const execPromise: Promise<string> = impl
    ? impl(step.args, { workspaceRoot: deps.workspaceRoot, signal: ac.signal }).catch((err: unknown) =>
        ac.signal.aborted ? '__aborted__' : `error: ${errorMessage(err)}`,
      )
    : Promise.resolve(`error: unknown tool ${step.name}`)

  for (;;) {
    const controls = await store.listUnconsumedControls(sessionId)
    if (findInterrupt(controls)) {
      ac.abort()
      await execPromise.catch(() => undefined)
      return 'interrupted'
    }
    const control = findToolControl(controls, step.toolCallId)
    if (control) {
      ac.abort() // discard partial output
      await execPromise.catch(() => undefined)
      return applyControl(control)
    }
    const settled = await Promise.race([
      execPromise.then((value) => ({ done: true as const, value })),
      sleep(deps.pollMs).then(() => ({ done: false as const })),
    ])
    if (settled.done) {
      await store.appendEvent(sessionId, 'tool_result', {
        toolCallId: step.toolCallId,
        name: step.name,
        result: settled.value,
      })
      return 'resolved'
    }
  }
}
