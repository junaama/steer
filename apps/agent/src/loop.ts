import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyTool, validateToolArgs } from '@steer/schema'
import type { AgentStore, StoredEvent } from './store.js'
import type { ToolFn } from './tools/index.js'
import type { SubagentDriverFactory } from './subagent.js'
import { applyEdits, type Edit } from './tools/edit.js'
import { resolveTool } from './intercept.js'
import { decideTurn, type ToolCall, type TurnResult } from './decide.js'

export type { ToolCall, TurnResult } from './decide.js'

async function readBefore(root: string, path: string): Promise<string> {
  try {
    return await readFile(join(root, path), 'utf8')
  } catch {
    return ''
  }
}

const FILE_MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit'])
const PLAN_TOOL = 'todo_write'
const ASK_USER_TOOL = 'ask_user'

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

/**
 * Callbacks the loop hands the driver so streamed reasoning/text reach the loop
 * as they arrive. The driver invokes these with raw provider chunks; the loop
 * buffers them and flushes coarse `thinking_delta`/`message_delta` rows.
 */
export interface TurnHooks {
  /** Invoked with each chunk of the assistant's streamed reply text. */
  onTextDelta?: (chunk: string) => void
  /** Invoked with each chunk of the assistant's streamed reasoning. */
  onReasoningDelta?: (chunk: string) => void
}

/**
 * The streaming model driver contract. One `next` call runs ONE streamed
 * assistant turn: it invokes the hooks with reasoning/text chunks as they arrive
 * and resolves to the turn's full outcome — coalesced text, coalesced reasoning,
 * and the whole batch of tool calls for the loop to execute through the gate.
 */
export interface ModelDriver {
  next(events: StoredEvent[], cursor: number, hooks: TurnHooks): Promise<TurnResult>
}

/**
 * A scripted turn for the fake streaming driver. `textDeltas`/`reasoningDeltas`
 * are streamed through the hooks in order; their concatenation is the turn's
 * coalesced text/reasoning unless `text`/`reasoning` override it. `toolCalls`
 * is the batch the loop then executes. A turn with no tool calls ends the run.
 */
export interface ScriptedTurn {
  textDeltas?: string[]
  reasoningDeltas?: string[]
  text?: string
  reasoning?: string
  toolCalls?: ToolCall[]
}

/**
 * The number of terminal events a scripted turn commits — reasoning (1),
 * message (1), plus one per tool call. The fake driver maps the terminal-count
 * cursor onto a turn by consuming these budgets, so it stays a pure function of
 * the log (crash-safe — no in-memory turn counter that a restart would lose).
 */
function turnTerminalCost(turn: ScriptedTurn): number {
  const reasoning = turn.reasoning ?? (turn.reasoningDeltas ?? []).join('')
  const text = turn.text ?? (turn.textDeltas ?? []).join('')
  return (reasoning.trim().length > 0 ? 1 : 0) + (text.trim().length > 0 ? 1 : 0) + (turn.toolCalls ?? []).length
}

/**
 * Deterministic streaming driver for tests — the streaming successor to the old
 * single-step `ScriptedModel`. It resolves which turn to emit purely from the
 * cursor (terminal count) by walking the scripted turns' terminal budgets, streams
 * that turn's deltas through the hooks, and returns its coalesced text/reasoning +
 * tool-call batch. Deriving the turn from the cursor (not an in-memory counter)
 * keeps crash-resume honest: a mid-run restart recomputes the cursor from the log
 * and resumes on the same turn. Past the script it returns an empty no-tool turn,
 * which ends the run.
 */
export class FakeStreamingModel implements ModelDriver {
  constructor(
    private readonly script: ScriptedTurn[],
    private readonly opts: { failAtCursor?: number } = {},
  ) {}

  /** Map the terminal-count cursor to the scripted turn whose budget it falls in. */
  private turnAt(cursor: number): ScriptedTurn {
    let consumed = 0
    for (const turn of this.script) {
      const cost = turnTerminalCost(turn)
      if (cursor < consumed + Math.max(cost, 1)) return turn
      consumed += cost
    }
    return {}
  }

  async next(_events: StoredEvent[], cursor: number, hooks: TurnHooks): Promise<TurnResult> {
    if (this.opts.failAtCursor !== undefined && cursor === this.opts.failAtCursor) {
      throw new Error('simulated crash')
    }
    const turn = this.turnAt(cursor)
    const reasoningDeltas = turn.reasoningDeltas ?? []
    const textDeltas = turn.textDeltas ?? []
    for (const chunk of reasoningDeltas) hooks.onReasoningDelta?.(chunk)
    for (const chunk of textDeltas) hooks.onTextDelta?.(chunk)
    return {
      reasoning: turn.reasoning ?? reasoningDeltas.join(''),
      text: turn.text ?? textDeltas.join(''),
      toolCalls: turn.toolCalls ?? [],
    }
  }
}

const TERMINAL_TYPES = new Set(['thinking', 'message', 'tool_result', 'tool_cancelled', 'tool_substituted'])
const DEFAULT_MAX_STEPS = 80

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Coarse delta flush: buffer streamed chunks and emit a `*_delta` row only on a
// natural boundary (newline or sentence-ender) or once the buffer reaches this
// many characters — never one row per token. Bounds event-log growth while
// keeping the live transcript smooth (the chunk-granularity decision the plan
// deferred). The remainder coalesces into the terminal event on turn finish.
const DELTA_FLUSH_CHARS = 80
const BOUNDARY = /[\n.!?]/

/**
 * Buffers streamed chunks and yields coarse flushes on a boundary or once the
 * buffer crosses DELTA_FLUSH_CHARS. `take` empties the buffer (turn finish needs
 * what's left, but only the terminal event carries it — see runSession). Pure
 * string folding, no I/O, so it survives a daemon restart trivially (the buffer
 * is rebuilt from nothing each turn; the durable text lives in the terminal row).
 */
function makeDeltaBuffer(): {
  push: (chunk: string) => string | null
  drain: () => string
} {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      if (buffer.length >= DELTA_FLUSH_CHARS || BOUNDARY.test(chunk)) {
        const flushed = buffer
        buffer = ''
        return flushed
      }
      return null
    },
    drain() {
      const remaining = buffer
      buffer = ''
      return remaining
    },
  }
}

/**
 * The completed-step count is derived from the event log: each turn ends in
 * terminal events (a `thinking`/`message` and/or one terminal per tool call).
 * Streamed deltas are NON-terminal, so they never advance the cursor — on restart,
 * recomputing this resumes from the last committed terminal without re-running
 * committed work (crash-only resume). Counting terminals (not turns) keeps the
 * safety ceiling honest: a turn that fires many tools costs many steps.
 */
export function completedSteps(events: StoredEvent[]): number {
  return events.filter((e) => TERMINAL_TYPES.has(e.type)).length
}

// A model is "stuck" once it re-proposes a call that already returned the same
// result this many times — far tighter than the step cap, which let dozens of
// identical calls through before stopping.
const REPEAT_LIMIT = 3

// Read-only search tools whose fruitless result is a fixed sentinel (grep
// "— no matches", glob "— no files"). When one of these returns the identical
// fruitless result REPEAT_LIMIT times running while only its args change, the
// model is thrashing the search space — the grep loop that walked the step cap.
// list_dir is intentionally excluded: switching to a new directory is real
// exploration whose results normally differ, so the same-result check already
// guards it without the args-agnostic rule below.
const SEARCH_TOOLS = new Set(['grep', 'glob'])

function callKey(name: string, args: unknown): string {
  return `${name}(${JSON.stringify(args)})`
}

/** Each executed tool call as (name+args key, tool name, result), in log order. */
function executedCalls(events: readonly StoredEvent[]): { key: string; name: string; result: string }[] {
  const meta = new Map<string, { key: string; name: string }>()
  const out: { key: string; name: string; result: string }[] = []
  for (const e of events) {
    const p = e.payload as { toolCallId?: unknown; name?: unknown; args?: unknown; result?: unknown }
    if (typeof p.toolCallId !== 'string') continue
    if (e.type === 'tool_proposed') {
      const name = String(p.name ?? '')
      meta.set(p.toolCallId, { key: callKey(name, p.args), name })
    } else if (e.type === 'tool_result') {
      const m = meta.get(p.toolCallId)
      if (m !== undefined) out.push({ key: m.key, name: m.name, result: String(p.result ?? '') })
    }
  }
  return out
}

/**
 * Find a cached result for a prior web_fetch call on the same URL. Scans the
 * event log for a tool_proposed/tool_result pair where the tool is web_fetch
 * and the URL argument matches. Returns the cached result string, or undefined
 * if no prior fetch exists for that URL.
 */
export function findCachedWebFetch(
  events: readonly StoredEvent[],
  url: string,
): string | undefined {
  const pendingFetches = new Map<string, string>() // toolCallId -> url
  for (const e of events) {
    const p = e.payload as { toolCallId?: unknown; name?: unknown; args?: unknown; result?: unknown }
    if (typeof p.toolCallId !== 'string') continue
    if (e.type === 'tool_proposed' && p.name === 'web_fetch') {
      const args = p.args as { url?: unknown } | undefined
      if (typeof args?.url === 'string') pendingFetches.set(p.toolCallId, args.url)
    } else if (e.type === 'tool_result') {
      const fetchedUrl = pendingFetches.get(p.toolCallId)
      if (fetchedUrl === url) return String(p.result ?? '')
    }
  }
  return undefined
}

/**
 * True when the model is about to make a no-progress search/inspect call — the
 * last REPEAT_LIMIT executed calls all returned the same result (no new
 * information), and the proposed call would extend that streak. Two shapes trip
 * it:
 *
 *   1. Exact repeat — the proposed call matches the identical recent calls
 *      (e.g. listing the same dir over and over after a task it can't finish).
 *   2. Fruitless search — the proposed call and the recent calls are all the
 *      SAME search tool (grep/glob) returning that identical fruitless result
 *      while only the args change (e.g. grep "content-length" over file after
 *      file, each "— no matches"). The exact-repeat rule alone missed this
 *      because every (name+args) key differs, so it walked the step cap.
 *
 * Differing results (polling a file as it changes, or a search that actually
 * finds varied matches) mean progress and don't trip this. Bounds the flailing
 * the step cap otherwise let run wild.
 */
export function isNoProgressRepeat(
  events: readonly StoredEvent[],
  step: { name: string; args: Record<string, unknown> },
): boolean {
  const calls = executedCalls(events)
  if (calls.length < REPEAT_LIMIT) return false
  const recent = calls.slice(-REPEAT_LIMIT)
  // No new information: every recent call returned the identical result.
  if (!recent.every((c) => c.result === recent[0]!.result)) return false
  // (1) Exact repeat — the proposed call is identical to the recent ones.
  const key = callKey(step.name, step.args)
  if (recent.every((c) => c.key === key)) return true
  // (2) Fruitless search — same search tool, varied args, identical result.
  return SEARCH_TOOLS.has(step.name) && recent.every((c) => c.name === step.name)
}

function parentEvents(events: StoredEvent[]): StoredEvent[] {
  return events.filter((event) => {
    const payload = event.payload as { parentToolCallId?: unknown }
    return typeof payload.parentToolCallId !== 'string'
  })
}

/** A single todo in the agent's plan — the shape the `todo_write` tool writes. */
type PlanItem = { text: string; status: 'pending' | 'in_progress' | 'done' }

/**
 * Fold the event log to the current plan: the items of the latest `plan` event,
 * or null when the session has no plan. This is the same projection the UI's todo
 * panel and the LLM context build from the log, so reconciling against it keeps
 * every view of the plan consistent.
 */
export function latestPlan(events: readonly StoredEvent[]): PlanItem[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'plan') continue
    const items = (event.payload as { items?: unknown }).items
    return Array.isArray(items) ? (items as PlanItem[]) : null
  }
  return null
}

/**
 * Reconcile the plan with a finished run. A completed session must not leave todos
 * reading `pending`/`in_progress` — that's the drift where a "Complete" session's
 * plan still looked unfinished. Returns the items with every status set to `done`,
 * or null when there is nothing to reconcile (no plan, or it already reads as all
 * done) so the caller appends a `plan` event only when it actually changes the log.
 */
export function planMarkedAllDone(items: readonly PlanItem[] | null): PlanItem[] | null {
  if (!items || items.length === 0) return null
  if (items.every((item) => item.status === 'done')) return null
  return items.map((item): PlanItem => ({ ...item, status: 'done' }))
}

export interface RunOptions {
  /** The session's working directory — where relative paths resolve, shells run. */
  workspaceRoot: string
  /** Sandbox boundary file access is confined to (broad daemon root). Defaults to workspaceRoot. */
  root?: string
  tools: Record<string, ToolFn>
  signal?: AbortSignal
  /** Control-poll interval for the approval gate + live cancel (ms). */
  pollMs?: number
  /** Safety ceiling on completed steps before a run is force-stopped (default 80). */
  maxSteps?: number
  /** Factory for in-process child loops used by the task tool. */
  subagentDriver?: SubagentDriverFactory
}

/** Outcome of handling one tool call in a turn's batch — directs the loop. */
type ToolOutcome = 'continue' | 'interrupted' | 'no-progress' | 'aborted'

/**
 * Run a session to completion (or until interrupted). The agent keeps no private
 * state — everything is read from / appended to the synced event log, so a crash
 * mid-run resumes from the log on the next call. A turn streams reasoning/text as
 * coarse delta rows, coalesces them into terminal events, then executes the whole
 * tool-call batch through the approval gate. The run ends when a turn proposes no
 * tools (it has answered), or is force-stopped by the safety ceiling / no-progress
 * guard.
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
    // Operator interrupt halts at the turn boundary (control-plane-via-data-plane).
    const interrupted = await checkInterrupt(store, sessionId)
    if (interrupted) return

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

    // Stream one assistant turn: deltas flush as coarse rows; the buffers'
    // remainders coalesce into terminal thinking/message events below. Delta
    // appends are SERIALIZED onto one tail promise — each assigns seq from
    // max(seq)+1, so two concurrent appends would collide on the same seq.
    // Chaining keeps them ordered and atomic while the driver streams.
    const textBuf = makeDeltaBuffer()
    const reasoningBuf = makeDeltaBuffer()
    let deltaTail: Promise<unknown> = Promise.resolve()
    const flushDelta = (type: 'thinking_delta' | 'message_delta', chunk: string | null): void => {
      if (chunk === null || chunk.length === 0) return
      deltaTail = deltaTail.then(() => store.appendEvent(sessionId, type, { text: chunk }))
    }
    const result = await driver.next(visibleEvents, cursor, {
      onReasoningDelta: (chunk) => flushDelta('thinking_delta', reasoningBuf.push(chunk)),
      onTextDelta: (chunk) => flushDelta('message_delta', textBuf.push(chunk)),
    })
    // Drain trailing buffer contents as final deltas so every streamed character
    // is represented as a delta row before the terminal event coalesces them.
    flushDelta('thinking_delta', reasoningBuf.drain())
    flushDelta('message_delta', textBuf.drain())
    await deltaTail

    // Coalesce the turn: persist reasoning + text as terminal events (reasoning
    // is KEPT even when the turn also calls tools — origin R2), then process the
    // tool batch. `complete` is true only when the turn proposed no tools (R5).
    const decision = decideTurn(visibleEvents, result)
    if (decision.thinking !== undefined) await store.appendEvent(sessionId, 'thinking', { text: decision.thinking })
    if (decision.message !== undefined) await store.appendEvent(sessionId, 'message', { text: decision.message })

    if (decision.complete) {
      // Link the plan artifact to the loop's progress: on a clean finish, flip any
      // still-open todos to done so the synced plan can't read as unfinished while
      // the session shows Complete. Append-only — every plan projection follows.
      const finishedPlan = planMarkedAllDone(latestPlan(await store.listEvents(sessionId)))
      if (finishedPlan) await store.appendEvent(sessionId, 'plan', { items: finishedPlan })
      await store.setStatus(sessionId, 'completed')
      return
    }

    // Execute the turn's tool-call batch sequentially through the gate. Each
    // side-effecting call still hits the approval gate (R15); read-only calls run
    // immediately. A no-progress repeat, an interrupt, or a run-level abort
    // (daemon shutdown while parked on an ask_user question) ends the loop.
    let stopped = false
    for (const call of decision.toolCalls) {
      const outcome = await handleToolCall(store, sessionId, call, options, maxSteps, allowlist)
      // 'aborted' = the signal fired (daemon shutting down) while parked on an
      // ask_user wait — exit WITHOUT changing status so the run stays runnable and
      // a resume re-reaches the wait (crash-only resume; the answer is never lost).
      if (outcome === 'interrupted' || outcome === 'no-progress' || outcome === 'aborted') {
        stopped = true
        break
      }
    }
    if (stopped) return
  }
}

/**
 * Halt the run at a turn boundary if an interrupt control is pending: consume it,
 * record an `interrupted` event at the current seq, and flip the session pill.
 * Returns true when the run halted.
 */
async function checkInterrupt(store: AgentStore, sessionId: string): Promise<boolean> {
  const pending = await store.listUnconsumedControls(sessionId)
  const interrupt = pending.find((c) => c.type === 'interrupt')
  if (!interrupt) return false
  await store.consumeControl(interrupt.id)
  const events = await store.listEvents(sessionId)
  const atSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
  await store.appendEvent(sessionId, 'interrupted', { atSeq })
  await store.setStatus(sessionId, 'interrupted')
  return true
}

/**
 * Execute one tool call from a turn's batch with full interception. Re-reads the
 * event log for each call so the no-progress guard and web_fetch cache see prior
 * calls in the SAME turn (multi-tool turns must still be bounded). Side-effecting
 * calls flip the pill to AWAITING APPROVAL and park at the gate; read-only calls
 * run live. Returns how the loop should proceed.
 */
async function handleToolCall(
  store: AgentStore,
  sessionId: string,
  call: ToolCall,
  options: RunOptions,
  maxSteps: number,
  allowlist: Set<string>,
): Promise<ToolOutcome> {
  const visibleEvents = parentEvents(await store.listEvents(sessionId))

  // ask_user (R11): pause and wait for the operator's answer instead of guessing.
  // It takes a DEDICATED branch, not the approve/reject gate — the operator
  // answers the question, they don't approve a side effect. The question + answer
  // live in the event log (crash-safe), and the answer projects into the next
  // turn's context (context.ts), so the model sees it without extra plumbing.
  if (call.name === ASK_USER_TOOL) {
    return askUser(store, sessionId, call, options)
  }

  // No-progress guard: a model re-proposing the same call after it returned the
  // same result REPEAT_LIMIT times is stuck — stop with an explanation instead
  // of spinning to the step cap.
  if (isNoProgressRepeat(visibleEvents, call)) {
    await store.appendEvent(sessionId, 'message', {
      text: `Stopped: \`${call.name}\` repeated ${REPEAT_LIMIT}× with the same result and made no progress. The path may be outside this workspace, or the task can't be done in this environment — refine the task or steer it from the UI.`,
    })
    await store.setStatus(sessionId, 'error')
    return 'no-progress'
  }

  // URL dedup for web_fetch: a repeat fetch of a URL already fetched this session
  // returns the cached result instead of burning a network request (and tripping
  // the no-progress guard on the duplicate).
  if (call.name === 'web_fetch') {
    const url = (call.args as { url?: unknown }).url
    if (typeof url === 'string') {
      const cached = findCachedWebFetch(visibleEvents, url)
      if (cached !== undefined) {
        await store.appendEvent(sessionId, 'tool_proposed', {
          toolCallId: call.toolCallId,
          name: call.name,
          kind: classifyTool(call.name),
          args: call.args,
        })
        await store.appendEvent(sessionId, 'tool_result', {
          toolCallId: call.toolCallId,
          name: call.name,
          result: cached,
        })
        return 'continue'
      }
    }
  }

  // Tool step — interception: U8 approval gate, U9 override, U10 live cancel.
  const kind = classifyTool(call.name)
  const proposed: Record<string, unknown> = {
    toolCallId: call.toolCallId,
    name: call.name,
    kind,
    args: call.args,
  }
  // Emit before/after for file-mutating tools so the UI can render a diff.
  const preview = await fileMutationPreview(options.workspaceRoot, call.name, call.args)
  if (preview) Object.assign(proposed, preview)
  await store.appendEvent(sessionId, 'tool_proposed', proposed)
  // A side-effecting tool blocks at the approval gate — flip the session pill to
  // AWAITING APPROVAL while it waits so the operator sees it needs a decision
  // (the interrupt path owns 'interrupted', so don't reset that case).
  const gated = kind === 'side-effecting' && !allowlist.has(call.name)
  if (gated) await store.setStatus(sessionId, 'awaiting-approval')
  const outcome = await resolveTool(store, sessionId, call, {
    tools: options.tools,
    workspaceRoot: options.workspaceRoot,
    root: options.root,
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
    return 'interrupted'
  }
  if (call.name === PLAN_TOOL) await reconcilePlanFromTool(store, sessionId, call)
  if (gated) await store.setStatus(sessionId, 'running')
  return 'continue'
}

/**
 * The seq of the `question` event already emitted for this `ask_user` call, or
 * undefined if none. Used to make the wait idempotent across a crash-resume: the
 * resumed run reuses the original question's seq, so an answer the operator gave
 * before the crash (a `user_message` after that seq) is still recognized.
 */
export function questionSeqFor(events: readonly StoredEvent[], toolCallId: string): number | undefined {
  for (const e of events) {
    if (e.type === 'question' && (e.payload as { toolCallId?: unknown }).toolCallId === toolCallId) {
      return e.seq
    }
  }
  return undefined
}

/**
 * The first `user_message` whose seq is strictly after `afterSeq` — the operator's
 * answer to a question posed at `afterSeq`. Returns its text, or undefined while no
 * answer has arrived. Keyed off seq (not "latest message") so a follow-up sent
 * BEFORE the question can't be mistaken for the answer, and so a crash-resumed wait
 * still finds the answer the operator already gave.
 */
export function findAnswerAfter(events: readonly StoredEvent[], afterSeq: number): string | undefined {
  for (const e of events) {
    if (e.seq > afterSeq && e.type === 'user_message') {
      return String((e.payload as { text?: unknown }).text ?? '')
    }
  }
  return undefined
}

/**
 * ask_user (R11, AE4): emit the question, park the session 'awaiting-input', and
 * BLOCK until the operator answers (a `user_message`) — never guessing, never
 * giving up. The answer carrier is a `user_message`, reusing the existing
 * follow-up-message machinery: the server's `/sessions/:id/message` endpoint
 * already appends it and re-queues the session, the web composer already sends it,
 * and `context.ts` already projects it as a user turn — so the answer reaches the
 * model with no new control type and no server change. An interrupt still halts
 * the wait (no deadlock). The question + answer live in the event log, so a crash
 * mid-wait resumes here and re-finds the answer instead of losing it.
 */
async function askUser(
  store: AgentStore,
  sessionId: string,
  call: ToolCall,
  options: RunOptions,
): Promise<ToolOutcome> {
  // Idempotent by toolCallId so a crash-resumed wait reuses the SAME question seq
  // (and therefore still recognizes an answer the operator already gave) instead
  // of re-asking at a higher seq the prior answer would fall before. The question
  // is appended only the first time this call is reached.
  const existingQuestionSeq = questionSeqFor(await store.listEvents(sessionId), call.toolCallId)
  let questionSeq: number
  if (existingQuestionSeq !== undefined) {
    questionSeq = existingQuestionSeq
  } else {
    const question = askUserQuestion(call.args)
    await store.appendEvent(sessionId, 'tool_proposed', {
      toolCallId: call.toolCallId,
      name: call.name,
      kind: classifyTool(call.name),
      args: call.args,
    })
    // A malformed ask_user (e.g. an empty question) can't be answered — surface it
    // as a tool error and continue rather than parking on a question nobody can see.
    if (question === undefined) {
      await store.appendEvent(sessionId, 'tool_result', {
        toolCallId: call.toolCallId,
        name: call.name,
        result: 'error: ask_user requires a non-empty question',
      })
      return 'continue'
    }
    questionSeq = await store.appendEvent(sessionId, 'question', {
      toolCallId: call.toolCallId,
      question,
    })
  }
  await store.setStatus(sessionId, 'awaiting-input')

  const pollMs = options.pollMs ?? 200
  for (;;) {
    // Daemon shutdown: stop polling and leave the session 'awaiting-input' so a
    // resume re-enters this wait (the question/answer live in the log).
    if (options.signal?.aborted) return 'aborted'
    const controls = await store.listUnconsumedControls(sessionId)
    const interrupt = controls.find((c) => c.type === 'interrupt')
    if (interrupt) {
      await store.consumeControl(interrupt.id)
      const events = await store.listEvents(sessionId)
      const atSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
      await store.appendEvent(sessionId, 'interrupted', { atSeq })
      await store.setStatus(sessionId, 'interrupted')
      return 'interrupted'
    }
    const answer = findAnswerAfter(await store.listEvents(sessionId), questionSeq)
    if (answer !== undefined) {
      // Record the answer as the ask_user tool_result so the asking call has a
      // coherent outcome in the thread; the `user_message` itself carries it into
      // the model context. Flip back to running and continue the loop.
      await store.appendEvent(sessionId, 'tool_result', {
        toolCallId: call.toolCallId,
        name: call.name,
        result: answer,
      })
      await store.setStatus(sessionId, 'running')
      return 'continue'
    }
    await sleep(pollMs)
  }
}

/** The validated ask_user question, or undefined when the args are malformed. */
function askUserQuestion(args: Record<string, unknown>): string | undefined {
  try {
    return (validateToolArgs(ASK_USER_TOOL, args) as { question: string }).question
  } catch {
    return undefined
  }
}

/**
 * After a `todo_write` tool_result, append a `plan` event mirroring its args so
 * every plan projection (UI panel, LLM context) follows the log. Malformed args
 * leave the durable plan untouched — the tool_result already records the error.
 */
async function reconcilePlanFromTool(store: AgentStore, sessionId: string, call: ToolCall): Promise<void> {
  const afterTool = await store.listEvents(sessionId)
  const terminal = [...afterTool].reverse().find((event) => {
    const payload = event.payload as { toolCallId?: unknown; name?: unknown }
    return payload.toolCallId === call.toolCallId && payload.name === PLAN_TOOL
  })
  if (terminal?.type !== 'tool_result') return
  try {
    const { items } = validateToolArgs(PLAN_TOOL, call.args) as {
      items: { text: string; status: 'pending' | 'in_progress' | 'done' }[]
    }
    await store.appendEvent(sessionId, 'plan', { items })
  } catch {
    // The tool_result already records the validation error; malformed args must
    // not become the durable current plan.
  }
}
