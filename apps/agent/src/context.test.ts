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

  it('projects a follow-up user_message as a user turn (multi-turn)', () => {
    const msgs = buildContext('initial task', [
      ev(0, 'message', { text: 'done' }),
      ev(1, 'user_message', { text: 'now add tests' }),
    ])
    expect(msgs).toEqual([
      { role: 'user', content: 'initial task' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'now add tests' },
    ])
  })

  it('adds no plan note when no plan event exists', () => {
    expect(buildContext('fix login', [ev(0, 'message', { text: 'done' })])).toEqual([
      { role: 'user', content: 'fix login' },
      { role: 'assistant', content: 'done' },
    ])
  })

  it('includes the latest plan event as a system note', () => {
    const msgs = buildContext(null, [
      ev(0, 'plan', { items: [{ text: 'old item', status: 'pending' }] }),
      ev(1, 'message', { text: 'working' }),
      ev(2, 'plan', {
        items: [
          { text: 'write tests', status: 'pending' },
          { text: 'implement tool', status: 'in_progress' },
          { text: 'verify coverage', status: 'done' },
        ],
      }),
    ])
    expect(msgs[0]).toEqual({
      role: 'system',
      content:
        'Current todo list:\n- [pending] write tests\n- [in_progress] implement tool\n- [done] verify coverage',
    })
    expect(msgs).toContainEqual({ role: 'assistant', content: 'working' })
    expect(JSON.stringify(msgs)).not.toContain('old item')
  })

  it('treats an empty latest plan as the current plan note', () => {
    expect(buildContext(null, [ev(0, 'plan', { items: [] })])).toEqual([
      { role: 'system', content: 'Current todo list:\n' },
    ])
  })

  it('omits malformed latest plan payloads', () => {
    expect(buildContext(null, [ev(0, 'plan', {})])).toEqual([])
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
