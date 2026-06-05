import { describe, it, expect } from 'vitest'
import { decideTurn, type ToolCall } from './decide.js'
import type { StoredEvent } from './store.js'

const ev = (seq: number, type: StoredEvent['type'], payload: Record<string, unknown> = {}): StoredEvent => ({
  sessionId: 's',
  seq,
  type,
  payload,
})

const call = (toolCallId: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({
  toolCallId,
  name,
  args,
})

describe('decideTurn', () => {
  it('processes the whole tool batch and does not complete while tools are called', () => {
    const tools = [call('tc1', 'grep', { p: 'x' }), call('tc2', 'read_file', { path: 'a' })]
    expect(decideTurn([], { text: '', reasoning: '', toolCalls: tools })).toEqual({
      toolCalls: tools,
      complete: false,
    })
  })

  it('KEEPS reasoning AND text alongside tool calls (origin R2 — no discard)', () => {
    const tools = [call('tc1', 'edit_file', { path: 'a' })]
    expect(
      decideTurn([], { text: 'editing the file now', reasoning: 'I should change line 2', toolCalls: tools }),
    ).toEqual({
      thinking: 'I should change line 2',
      message: 'editing the file now',
      toolCalls: tools,
      complete: false,
    })
  })

  it('completes when there is no tool call and no text', () => {
    expect(decideTurn([ev(0, 'user_message', { text: 'hi' })], { text: '   ', reasoning: '', toolCalls: [] })).toEqual({
      toolCalls: [],
      complete: true,
    })
  })

  it('answers the initial task and completes (first turn, no events, no tools)', () => {
    expect(decideTurn([], { text: 'blue', reasoning: '', toolCalls: [] })).toEqual({
      message: 'blue',
      toolCalls: [],
      complete: true,
    })
  })

  it('replies to a follow-up user_message', () => {
    const events = [ev(0, 'message', { text: 'blue' }), ev(1, 'user_message', { text: 'what word?' })]
    expect(decideTurn(events, { text: 'blue', reasoning: '', toolCalls: [] })).toEqual({
      message: 'blue',
      toolCalls: [],
      complete: true,
    })
  })

  it('answers after tool output (last event is a tool_result)', () => {
    expect(
      decideTurn([ev(0, 'tool_result', { name: 'grep', result: 'x' })], { text: 'found it', reasoning: '', toolCalls: [] }),
    ).toEqual({ message: 'found it', toolCalls: [], complete: true })
  })

  it('drops a no-tool duplicate message once the assistant has already spoken (no ramble)', () => {
    // Last event is the assistant message we just wrote -> the turn completes
    // without appending a duplicate trailing message.
    expect(decideTurn([ev(0, 'message', { text: 'blue' })], { text: 'more chatter', reasoning: '', toolCalls: [] })).toEqual({
      toolCalls: [],
      complete: true,
    })
  })

  it('KEEPS reasoning on a final no-tool turn even when the message is dropped', () => {
    // Reasoning is preserved independently of the duplicate-message drop.
    expect(
      decideTurn([ev(0, 'message', { text: 'blue' })], { text: 'blue', reasoning: 'final check', toolCalls: [] }),
    ).toEqual({ thinking: 'final check', toolCalls: [], complete: true })
  })
})
