import { describe, it, expect } from 'vitest'
import { buildContext } from './context.js'
import type { StoredEvent } from './store.js'

const ev = (seq: number, type: StoredEvent['type'], payload: Record<string, unknown>): StoredEvent => ({
  sessionId: 's',
  seq,
  type,
  payload,
})

describe('buildContext', () => {
  it('starts with the task as a user message', () => {
    expect(buildContext('fix login', [])).toEqual([{ role: 'user', content: 'fix login' }])
  })

  it('defaults missing message text to empty', () => {
    expect(buildContext(null, [ev(0, 'message', {})])).toEqual([{ role: 'assistant', content: '' }])
  })

  it('maps assistant messages and tool results', () => {
    const msgs = buildContext(null, [
      ev(0, 'message', { text: 'hi' }),
      ev(1, 'tool_result', { name: 'grep', result: 'r' }),
    ])
    expect(msgs).toEqual([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '[tool grep result]\nr' },
    ])
  })

  it('projects a substitution as the executed tool with a system note (no extra inference)', () => {
    const msgs = buildContext(null, [
      ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: {} }),
      ev(1, 'tool_substituted', { toolCallId: 'tc1', name: 'read', from: 'grep', result: 'file body' }),
    ])
    expect(msgs).toContainEqual({ role: 'system', content: '[operator substituted grep → read]' })
    expect(msgs).toContainEqual({ role: 'user', content: '[tool read result]\nfile body' })
    // the original grep call is NOT represented as its own result
    expect(JSON.stringify(msgs)).not.toContain('[tool grep result]')
  })
})
