import type { Step } from './loop.js'
import type { StoredEvent } from './store.js'

export interface ModelResult {
  /** The model's tool call this turn, if any. */
  toolCall?: { toolCallId: string; name: string; args: Record<string, unknown> }
  /** The model's text this turn. */
  text: string
}

/**
 * Turn a model result + the event log into the next loop step.
 *
 * A tool call always wins. Otherwise a no-tool text answer is *terminal* for the
 * turn: we emit it, and on the next pass — when the last event is the assistant
 * message we just wrote and nothing new (a tool result or a fresh user_message)
 * has arrived since — we complete. That structural check is what ends a turn
 * cleanly: it lets the agent reply to the initial task, to tool output, and to a
 * follow-up user_message, while stopping a no-tool model from rambling on after
 * it has already answered.
 */
export function decideStep(events: readonly StoredEvent[], result: ModelResult): Step {
  if (result.toolCall) {
    return { t: 'tool', toolCallId: result.toolCall.toolCallId, name: result.toolCall.name, args: result.toolCall.args }
  }
  const text = result.text.trim()
  if (text.length === 0) return { t: 'complete' }
  if (events[events.length - 1]?.type === 'message') return { t: 'complete' }
  return { t: 'say', text }
}
