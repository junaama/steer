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

  describe('streamed deltas', () => {
    it('folds consecutive message_delta rows into one growing message item', () => {
      const items = buildTrace([ev(0, 'message_delta', { text: 'Hel' }), ev(1, 'message_delta', { text: 'lo' })])
      expect(items).toHaveLength(1)
      const msg = items[0] as { kind: string; text: string; streaming?: boolean }
      expect(msg.kind).toBe('message')
      expect(msg.text).toBe('Hello')
      // Still streaming until a terminal `message` coalesces it.
      expect(msg.streaming).toBe(true)
    })

    it('folds thinking_delta rows the same way as message deltas', () => {
      const items = buildTrace([ev(0, 'thinking_delta', { text: 'wei' }), ev(1, 'thinking_delta', { text: 'gh' })])
      expect(items).toHaveLength(1)
      const t = items[0] as { kind: string; text: string; streaming?: boolean }
      expect(t.kind).toBe('thinking')
      expect(t.text).toBe('weigh')
      expect(t.streaming).toBe(true)
    })

    it('lets a terminal message replace its deltas — rendered once, no duplicate', () => {
      const items = buildTrace([
        ev(0, 'message_delta', { text: 'Hel' }),
        ev(1, 'message_delta', { text: 'lo' }),
        ev(2, 'message', { text: 'Hello, world' }),
      ])
      expect(items).toHaveLength(1)
      const msg = items[0] as { kind: string; text: string; streaming?: boolean }
      expect(msg.text).toBe('Hello, world')
      // The terminal clears the streaming flag.
      expect(msg.streaming).toBeUndefined()
    })

    it('lets a terminal thinking replace its deltas in place', () => {
      const items = buildTrace([ev(0, 'thinking_delta', { text: 'po' }), ev(1, 'thinking', { text: 'pondered' })])
      expect(items).toHaveLength(1)
      expect((items[0] as { text: string }).text).toBe('pondered')
      expect((items[0] as { streaming?: boolean }).streaming).toBeUndefined()
    })

    it('starts a fresh streaming item for deltas that arrive after a terminal coalesce', () => {
      const items = buildTrace([
        ev(0, 'message_delta', { text: 'one' }),
        ev(1, 'message', { text: 'first' }),
        ev(2, 'message_delta', { text: 'two' }),
      ])
      expect(items.map((i) => (i as { text: string }).text)).toEqual(['first', 'two'])
      expect((items[0] as { streaming?: boolean }).streaming).toBeUndefined()
      expect((items[1] as { streaming?: boolean }).streaming).toBe(true)
    })

    it('defaults a sparse message_delta to empty text', () => {
      const items = buildTrace([ev(0, 'message_delta', {})])
      expect((items[0] as { text: string }).text).toBe('')
    })

    it('accumulates tool_stdout_delta chunks as streaming output before the result', () => {
      const items = buildTrace([
        ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'run_command', kind: 'read-only', args: {} }),
        ev(1, 'tool_stdout_delta', { toolCallId: 'tc1', name: 'run_command', chunk: 'line1\n' }),
        ev(2, 'tool_stdout_delta', { toolCallId: 'tc1', name: 'run_command', chunk: 'line2' }),
      ])
      const tool = items[0] as ToolItem
      expect(tool.streamingOutput).toBe('line1\nline2')
      expect(tool.result).toBeNull()
    })

    it('keeps the streaming buffer but supersedes it once tool_result arrives', () => {
      const items = buildTrace([
        ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'run_command', kind: 'read-only', args: {} }),
        ev(1, 'tool_stdout_delta', { toolCallId: 'tc1', name: 'run_command', chunk: 'partial' }),
        ev(2, 'tool_result', { toolCallId: 'tc1', name: 'run_command', result: 'partial done' }),
      ])
      const tool = items[0] as ToolItem
      expect(tool.streamingOutput).toBe('partial')
      expect(tool.result).toBe('partial done')
    })

    it('defaults a sparse tool_stdout_delta chunk to empty string', () => {
      const items = buildTrace([
        ev(0, 'tool_proposed', { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: {} }),
        ev(1, 'tool_stdout_delta', { toolCallId: 'tc1', name: 'grep' }),
      ])
      expect((items[0] as ToolItem).streamingOutput).toBe('')
    })

    it('ignores a tool_stdout_delta with no prior proposal or a non-string id', () => {
      const items = buildTrace([
        ev(0, 'tool_stdout_delta', { toolCallId: 'ghost', name: 'grep', chunk: 'x' }),
        ev(1, 'tool_stdout_delta', { toolCallId: 99, name: 'grep', chunk: 'y' }),
      ])
      expect(items).toHaveLength(0)
    })

    it('streams deltas nested under a subagent tool card', () => {
      const items = buildTrace([
        ev(0, 'tool_proposed', { toolCallId: 'task1', name: 'task', kind: 'side-effecting', args: {} }),
        ev(1, 'message_delta', { parentToolCallId: 'task1', text: 'sub ' }),
        ev(2, 'message_delta', { parentToolCallId: 'task1', text: 'reply' }),
      ])
      const tool = items[0] as ToolItem
      expect(tool.children?.map((c) => c.kind)).toEqual(['message'])
      expect((tool.children?.[0] as { text: string }).text).toBe('sub reply')
    })
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
