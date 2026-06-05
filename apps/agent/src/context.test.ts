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

  it('keeps the original task in context after a failed turn + clarification (sess-eeb54402 shape)', () => {
    // The agent failed turn 1, the user clarified the path, and the model must
    // still see the ORIGINAL request. The leading user message must remain the
    // task, with the failed turn and the clarification following in order.
    const msgs = buildContext('whats the first line of the readme in the yourai folder', [
      ev(0, 'tool_result', { name: 'list_dir', result: '— no such dir' }),
      ev(1, 'message', { text: 'The yourai folder does not exist.' }),
      ev(2, 'user_message', { text: 'in dev/yourai' }),
      ev(3, 'tool_result', { name: 'list_dir', result: 'README.md\nDockerfile' }),
    ])
    expect(msgs[0]).toEqual({ role: 'user', content: 'whats the first line of the readme in the yourai folder' })
    // The original task is still present alongside the clarification — the model
    // has everything it needs to finish; completing it is a behavior the agent
    // eval (not this projection) must enforce.
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'user'])
    expect(msgs.some((m) => m.content === 'in dev/yourai')).toBe(true)
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

  it('projects a rebuilt assistant turn — reasoning streamed, message, then a multi-tool batch — coherently', () => {
    // A streaming turn persists thinking_delta/message_delta (non-context),
    // coalesced thinking + message, then several tool_results. The LLM thread
    // must carry the assistant message and EVERY tool result from the turn, in
    // order, so the next turn sees the full batch outcome.
    const msgs = buildContext('refactor utils', [
      ev(0, 'thinking_delta', { text: 'plan' }),
      ev(1, 'thinking', { text: 'I will grep then read both hits' }),
      ev(2, 'message_delta', { text: 'On it' }),
      ev(3, 'message', { text: 'Searching the codebase' }),
      ev(4, 'tool_result', { name: 'grep', result: 'utils.ts:1' }),
      ev(5, 'tool_result', { name: 'read_file', result: 'export const x = 1' }),
      ev(6, 'tool_result', { name: 'read_file', result: 'export const y = 2' }),
    ])
    // thinking/deltas are internal — not projected; the message + all three tool
    // results are, in log order.
    expect(msgs).toEqual([
      { role: 'user', content: 'refactor utils' },
      { role: 'assistant', content: 'Searching the codebase' },
      { role: 'user', content: '[tool grep result]\nutils.ts:1' },
      { role: 'user', content: '[tool read_file result]\nexport const x = 1' },
      { role: 'user', content: '[tool read_file result]\nexport const y = 2' },
    ])
  })

  it('projects an ask_user question + the operator answer into the thread (R11, AE4)', () => {
    // The agent asked a question (a non-context `question` event), recorded the
    // answer as the ask_user tool_result, and the operator's `user_message` carries
    // it. The model must see both the answer (as a user turn) and the tool result —
    // so the next turn acts on the clarification instead of re-asking or guessing.
    const msgs = buildContext('deploy the app', [
      ev(0, 'message', { text: 'I need to know the target environment' }),
      ev(1, 'tool_proposed', { toolCallId: 'ask1', name: 'ask_user', kind: 'side-effecting', args: { question: 'Which environment?' } }),
      ev(2, 'question', { toolCallId: 'ask1', question: 'Which environment?' }),
      ev(3, 'user_message', { text: 'production' }),
      ev(4, 'tool_result', { toolCallId: 'ask1', name: 'ask_user', result: 'production' }),
    ])
    // The `question` and `tool_proposed` events are non-context (the UI surfaces
    // the question); the answer reaches the model as a user turn AND as the
    // ask_user tool result, in log order.
    expect(msgs).toEqual([
      { role: 'user', content: 'deploy the app' },
      { role: 'assistant', content: 'I need to know the target environment' },
      { role: 'user', content: 'production' },
      { role: 'user', content: '[tool ask_user result]\nproduction' },
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
