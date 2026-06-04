import { describe, it, expect } from 'vitest'
import { buildTrace, latestPlan, type RawEvent, type ToolItem } from './trace.js'

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

  it('nests child subagent events under the parent task tool card', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', {
        toolCallId: 'task1',
        name: 'task',
        kind: 'side-effecting',
        args: { description: 'Inspect', prompt: 'Read a file' },
      }),
      ev(1, 'subagent_started', { parentToolCallId: 'task1', description: 'Inspect', prompt: 'Read a file' }),
      ev(2, 'thinking', { parentToolCallId: 'task1', text: 'looking' }),
      ev(3, 'tool_proposed', {
        parentToolCallId: 'task1',
        toolCallId: 'child-read',
        name: 'read_file',
        kind: 'read-only',
        args: { path: 'a.txt' },
      }),
      ev(4, 'tool_result', {
        parentToolCallId: 'task1',
        toolCallId: 'child-read',
        name: 'read_file',
        result: 'hello',
      }),
      ev(5, 'message', { parentToolCallId: 'task1', text: 'done' }),
      ev(6, 'subagent_result', { parentToolCallId: 'task1', summary: 'done' }),
      ev(7, 'tool_result', { toolCallId: 'task1', name: 'task', result: 'done' }),
    ])

    expect(items).toHaveLength(1)
    const tool = items[0] as ToolItem
    expect(tool.name).toBe('task')
    expect(tool.result).toBe('done')
    expect(tool.children?.map((item) => item.kind)).toEqual(['thinking', 'tool', 'message'])
    expect((tool.children?.[1] as ToolItem).result).toBe('hello')
  })

  it('keeps child-tagged events out of the top-level trace', () => {
    const items = buildTrace([
      ev(0, 'message', { parentToolCallId: 'task1', text: 'child-only' }),
      ev(1, 'message', { text: 'parent-only' }),
    ])
    expect(items).toEqual([{ kind: 'message', key: 'm-1', text: 'parent-only' }])
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

  it('flags editedArgs when the terminal tool_result carries edited', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'read_file', kind: 'read-only', args: { path: 'a' } }),
      ev(1, 'tool_result', { toolCallId: 'tc1', name: 'read_file', result: 'contents', edited: true }),
    ])
    const tool = items[0] as ToolItem
    expect(tool.status).toBe('done')
    expect(tool.editedArgs).toBe(true)
  })

  it('leaves editedArgs unset for a normal tool_result', () => {
    const items = buildTrace([
      ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: {} }),
      ev(1, 'tool_result', { toolCallId: 'tc1', name: 'grep', result: 'm' }),
    ])
    expect((items[0] as ToolItem).editedArgs).toBeUndefined()
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

describe('latestPlan', () => {
  it('returns null when no plan event is present', () => {
    expect(latestPlan([ev(0, 'message', { text: 'hi' })])).toBeNull()
  })

  it('returns the last plan by seq and leaves buildTrace unchanged', () => {
    const first = [{ text: 'old', status: 'pending' }]
    const second = [
      { text: 'write tests', status: 'pending' },
      { text: 'implement tool', status: 'in_progress' },
      { text: 'verify coverage', status: 'done' },
    ]
    const events = [
      ev(2, 'plan', { items: second }),
      ev(0, 'plan', { items: first }),
      ev(1, 'message', { text: 'working' }),
    ]
    expect(latestPlan(events)).toEqual(second)
    expect(buildTrace(events)).toEqual([{ kind: 'message', key: 'm-1', text: 'working' }])
  })

  it('returns an empty latest plan distinctly from an absent plan', () => {
    expect(latestPlan([ev(0, 'plan', { items: [] })])).toEqual([])
  })

  it('returns null for a malformed plan payload', () => {
    expect(latestPlan([ev(0, 'plan', {})])).toBeNull()
  })
})
