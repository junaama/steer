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

  it('does not mutate its input', () => {
    const input: RawEvent[] = [ev(0, 'message', { text: 'a' })]
    const frozen = Object.freeze(input)
    expect(() => buildTrace(frozen)).not.toThrow()
  })
})
