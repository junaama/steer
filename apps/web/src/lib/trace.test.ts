import { describe, it, expect } from 'vitest'
import { buildTrace, type RawEvent, type ToolItem } from './trace.js'

const ev = (seq: number, type: RawEvent['type'], payload: Record<string, unknown>): RawEvent => ({ seq, type, payload })

describe('buildTrace', () => {
  it('renders messages and thinking in seq order', () => {
    const items = buildTrace([
      ev(1, 'thinking', { text: 'hmm' }),
      ev(0, 'message', { text: 'hi' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['message', 'thinking'])
    expect((items[0] as { text: string }).text).toBe('hi')
  })

  it('projects a follow-up user_message as a user item, interleaved in order', () => {
    const items = buildTrace([
      ev(0, 'message', { text: 'done' }),
      ev(1, 'user_message', { text: 'now add tests' }),
      ev(2, 'message', { text: 'on it' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['message', 'user', 'message'])
    expect((items[1] as { text: string }).text).toBe('now add tests')
  })

  it('prepends the initial task as the opening "you" turn', () => {
    const items = buildTrace([ev(0, 'message', { text: 'on it' })], 'fix the bug')
    expect(items.map((i) => i.kind)).toEqual(['user', 'message'])
    expect((items[0] as { text: string }).text).toBe('fix the bug')
    expect(items[0]!.key).toBe('task')
  })

  it('does not prepend a blank or absent task', () => {
    expect(buildTrace([ev(0, 'message', { text: 'hi' })], '   ').map((i) => i.kind)).toEqual(['message'])
    expect(buildTrace([ev(0, 'message', { text: 'hi' })], null).map((i) => i.kind)).toEqual(['message'])
  })

  it('interleaves a user_message among tool cards in seq order', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: {} }),
      ev(1, 'tool_result', { toolCallId: 'tc1', name: 'grep', result: 'm' }),
      ev(2, 'user_message', { text: 'rerun it' }),
      ev(3, 'tool_proposed', { toolCallId: 'tc2', name: 'read', kind: 'read-only', args: {} }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['tool', 'user', 'tool'])
    expect((items[1] as { text: string }).text).toBe('rerun it')
  })

  it('defaults a sparse user_message to empty text', () => {
    const items = buildTrace([ev(0, 'user_message', {})])
    expect(items[0]!.kind).toBe('user')
    expect((items[0] as { text: string }).text).toBe('')
  })

  it('folds a read-only tool lifecycle into one running→done card', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: { pattern: 'x' } }),
      ev(1, 'tool_result', { toolCallId: 'tc1', name: 'grep', result: 'match' }),
    ])
    expect(items).toHaveLength(1)
    const tool = items[0] as ToolItem
    expect(tool.kind).toBe('tool')
    expect(tool.status).toBe('done')
    expect(tool.result).toBe('match')
  })

  it('starts side-effecting tools in the pending (approval) state', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', { toolCallId: 'w1', name: 'write_file', kind: 'side-effecting', args: { path: 'a' } }),
    ])
    expect((items[0] as ToolItem).status).toBe('pending')
  })

  it('records a substitution with audit (substitutedFrom)', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: {} }),
      ev(1, 'tool_substituted', { toolCallId: 'tc1', name: 'read', from: 'grep', result: 'file contents' }),
    ])
    const tool = items[0] as ToolItem
    expect(tool.status).toBe('substituted')
    expect(tool.name).toBe('read')
    expect(tool.substitutedFrom).toBe('grep')
    expect(tool.result).toBe('file contents')
  })

  it('marks a cancelled tool', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: {} }),
      ev(1, 'tool_cancelled', { toolCallId: 'tc1', name: 'grep', reason: 'operator cancelled' }),
    ])
    expect((items[0] as ToolItem).status).toBe('cancelled')
  })

  it('marks a tool running on tool_started', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: {} }),
      ev(1, 'tool_started', { toolCallId: 'tc1', name: 'grep' }),
    ])
    expect((items[0] as ToolItem).status).toBe('running')
  })

  it('carries before/after for file-writing proposals', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', {
        toolCallId: 'w1',
        name: 'write_file',
        kind: 'side-effecting',
        args: { path: 'a' },
        before: 'x',
        after: 'y',
      }),
    ])
    const tool = items[0] as ToolItem
    expect(tool.before).toBe('x')
    expect(tool.after).toBe('y')
  })

  it('ignores tool events with no prior proposal and non-string ids', () => {
    const items = buildTrace([
      ev(0, 'tool_result', { toolCallId: 'orphan', name: 'grep', result: 'r' }),
      ev(1, 'tool_proposed', { toolCallId: 123, name: 'grep', kind: 'read-only', args: {} }),
    ])
    expect(items).toHaveLength(0)
  })

  it('applies defaults for sparse payloads', () => {
    const items = buildTrace([
      ev(0, 'message', {}),
      ev(1, 'tool_proposed', { toolCallId: 'tc1', args: {} }),
    ])
    expect((items[0] as { text: string }).text).toBe('')
    const tool = items[1] as ToolItem
    expect(tool.toolKind).toBe('read-only')
    expect(tool.name).toBe('')
    expect(tool.args).toEqual({})
    expect(tool.before).toBeUndefined()
  })

  it('does not mutate its input', () => {
    const input: RawEvent[] = [ev(0, 'message', { text: 'a' })]
    const frozen = Object.freeze(input)
    expect(() => buildTrace(frozen)).not.toThrow()
  })
})
