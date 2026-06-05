import type { StoredEvent } from './store.js'

/** One tool call the model emitted this turn (the loop owns execution). */
export interface ToolCall {
  toolCallId: string
  name: string
  args: Record<string, unknown>
}

/**
 * The outcome of one streamed assistant turn. Reasoning and text are PRESERVED
 * alongside any tool calls — the old "tool call wins, text discarded" rule is
 * gone (origin R2). `toolCalls` is the full batch the model proposed this turn,
 * which the loop executes sequentially through the approval gate.
 */
export interface TurnResult {
  /** The assistant's reply text for this turn (coalesced from text deltas). */
  text: string
  /** The assistant's reasoning for this turn (coalesced from reasoning deltas). */
  reasoning: string
  /** Every tool call the model proposed this turn (may be empty). */
  toolCalls: ToolCall[]
}

/** What the loop should persist for a finished turn before executing its tools. */
export interface TurnDecision {
  /** Emit a terminal `thinking` event with this text (omitted when empty). */
  thinking?: string
  /** Emit a terminal `message` event with this text (omitted when empty). */
  message?: string
  /** The tool calls to execute through the gate, in order (may be empty). */
  toolCalls: ToolCall[]
  /** True when the turn proposed no tool calls — the run completes after it. */
  complete: boolean
}

/**
 * Turn a finished turn into the events the loop must persist.
 *
 * Reasoning and text are both kept, even when the turn also calls tools — this
 * is the fix for the old `decide.ts` discard (origin R2). A `message` is only
 * persisted when the turn has non-empty text AND adds new information: a no-tool
 * turn whose text merely repeats the assistant message we just wrote (the last
 * event is already a `message`) is dropped so a rambling model can't append
 * duplicate replies after it has answered.
 *
 * Completion (origin R5): a turn that proposes NO tool calls ends the run after
 * its message is emitted. While the model is still calling tools the run keeps
 * going — it never gives up mid-task.
 */
export function decideTurn(events: readonly StoredEvent[], result: TurnResult): TurnDecision {
  const reasoning = result.reasoning.trim()
  const text = result.text.trim()
  const hasTools = result.toolCalls.length > 0

  // Drop a no-tool text turn that only repeats the reply we just wrote — the
  // turn already answered, so don't append a duplicate trailing message.
  const lastWasMessage = events[events.length - 1]?.type === 'message'
  const keepMessage = text.length > 0 && (hasTools || !lastWasMessage)

  return {
    ...(reasoning.length > 0 ? { thinking: reasoning } : {}),
    ...(keepMessage ? { message: text } : {}),
    toolCalls: result.toolCalls,
    complete: !hasTools,
  }
}
