import { describe, it, expect } from 'vitest'
import { decideStep } from './decide.js'
import type { StoredEvent } from './store.js'

const ev = (seq: number, type: StoredEvent['type'], payload: Record<string, unknown> = {}): StoredEvent => ({
  sessionId: 's',
  seq,
  type,
  payload,
})

describe('decideStep', () => {
  it('returns a tool step when the model calls a tool', () => {
    expect(decideStep([], { toolCall: { toolCallId: 'tc1', name: 'grep', args: { p: 'x' } }, text: '' })).toEqual({
      t: 'tool',
      toolCallId: 'tc1',
      name: 'grep',
      args: { p: 'x' },
    })
  })

  it('completes when there is no tool call and no text', () => {
    expect(decideStep([ev(0, 'user_message', { text: 'hi' })], { text: '   ' })).toEqual({ t: 'complete' })
  })

  it('answers the initial task (first turn, no events yet)', () => {
    expect(decideStep([], { text: 'blue' })).toEqual({ t: 'say', text: 'blue' })
  })

  it('replies to a follow-up user_message', () => {
    const events = [ev(0, 'message', { text: 'blue' }), ev(1, 'user_message', { text: 'what word?' })]
    expect(decideStep(events, { text: 'blue' })).toEqual({ t: 'say', text: 'blue' })
  })

  it('answers after tool output (last event is a tool_result)', () => {
    expect(decideStep([ev(0, 'tool_result', { name: 'grep', result: 'x' })], { text: 'found it' })).toEqual({
      t: 'say',
      text: 'found it',
    })
  })

  it('completes (no ramble) once the assistant has spoken and nothing new arrived', () => {
    // Last event is the assistant message we just wrote -> the turn is done.
    expect(decideStep([ev(0, 'message', { text: 'blue' })], { text: 'more chatter' })).toEqual({ t: 'complete' })
  })
})
