import { describe, it, expect } from 'vitest'
import { decodeEvents, decodeSessions, formatEvent, isTerminal, type AgentEvent } from './events.js'

const row = (value: Record<string, unknown>) => ({ value, headers: { operation: 'insert' } })

describe('decodeEvents', () => {
  it('parses stringified payloads, coerces seq, sorts, and skips control rows', () => {
    const out = decodeEvents([
      row({ session_id: 's', seq: '2', type: 'message', payload: '{"text":"second"}' }),
      row({ session_id: 's', seq: '1', type: 'thinking', payload: '{"text":"first"}' }),
      { headers: { control: 'snapshot-end' } },
      { value: { seq: '9' } },
    ])
    expect(out.map((e) => e.seq)).toEqual([1, 2])
    expect(out[0]!.payload).toEqual({ text: 'first' })
  })

  it('accepts object payloads and falls back to {} for bad / missing / non-object JSON', () => {
    expect(decodeEvents([row({ seq: '0', type: 'message', payload: { text: 'x' } })])[0]!.payload).toEqual({ text: 'x' })
    expect(decodeEvents([row({ seq: '0', type: 'message', payload: 'nope' })])[0]!.payload).toEqual({})
    expect(decodeEvents([row({ seq: '0', type: 'message' })])[0]!.payload).toEqual({})
    expect(decodeEvents([row({ seq: '0', type: 'message', payload: '5' })])[0]!.payload).toEqual({})
  })
})

// `op` builds an Electric message with a chosen operation (insert/update/delete).
const op = (operation: string, value: Record<string, unknown>) => ({ value, headers: { operation } })

describe('decodeSessions', () => {
  it('reads last_status (snake) with a camelCase fallback and skips controls', () => {
    expect(
      decodeSessions([
        row({ id: 'a', title: 'A', last_status: 'running' }),
        row({ id: 'b', title: 'B', lastStatus: 'completed' }),
        { headers: {} },
      ]),
    ).toEqual([
      { id: 'a', title: 'A', lastStatus: 'running' },
      { id: 'b', title: 'B', lastStatus: 'completed' },
    ])
  })

  it('folds the op-log by id: full insert then partial updates merge (no duplicates)', () => {
    // Mirrors Electric on the wire: insert carries the full row, each update only
    // the changed column (+ id). A status-only update must not blank the title,
    // and a rename must not blank the status.
    expect(
      decodeSessions([
        op('insert', { id: 'a', title: 'orig', last_status: 'starting', model: 'sonnet', task: null }),
        op('update', { id: 'a', last_status: 'running' }),
        op('update', { id: 'a', title: 'renamed' }),
      ]),
    ).toEqual([{ id: 'a', title: 'renamed', lastStatus: 'running' }])
  })

  it('drops a session whose latest op is a delete', () => {
    const states = decodeSessions([
      op('insert', { id: 'a', title: 'A', last_status: 'completed' }),
      op('insert', { id: 'b', title: 'B', last_status: 'completed' }),
      op('delete', { id: 'a' }),
    ])
    expect(states.map((s) => s.id)).toEqual(['b'])
  })

  it('defaults missing fields for an update with no prior insert', () => {
    // Defensive: an update seen before its insert (cannot happen in a full drain).
    expect(decodeSessions([op('update', { id: 'x', last_status: 'running' })])).toEqual([
      { id: 'x', title: '', lastStatus: 'running' },
    ])
  })
})

describe('isTerminal', () => {
  it('matches terminal statuses only', () => {
    expect(['completed', 'interrupted', 'error'].every(isTerminal)).toBe(true)
    expect(isTerminal('running')).toBe(false)
  })
})

describe('formatEvent', () => {
  const f = (type: string, payload: Record<string, unknown>): string => formatEvent({ seq: 0, type, payload } as AgentEvent)

  it('renders every event type', () => {
    expect(f('thinking', { text: 'pondering' })).toContain('pondering')
    expect(f('message', { text: 'hello' })).toContain('hello')
    expect(f('tool_proposed', { name: 'grep', args: { pattern: 'x', path: 'src' } })).toContain('grep(')
    expect(f('tool_proposed', { name: 'bash', args: null })).toContain('bash()')
    expect(f('tool_result', { name: 'read', result: 'contents' })).toContain('ok read')
    expect(f('tool_substituted', { from: 'grep', name: 'read', result: 'r' })).toContain('replaced by read')
    expect(f('tool_cancelled', { name: 'bash' })).toContain('cancelled')
    expect(f('tool_cancelled', { name: 'bash', reason: 'rejected' })).toContain('rejected')
    expect(f('interrupted', {})).toContain('interrupted')
    expect(f('unknown_type', {})).toContain('unknown_type')
  })

  it('truncates long tool output but leaves messages whole', () => {
    const long = 'a'.repeat(500)
    expect(f('message', { text: long })).toContain(long)
    expect(f('tool_result', { name: 'x', result: long }).length).toBeLessThan(long.length)
  })

  it('handles missing fields without throwing', () => {
    expect(f('thinking', {})).toBeTypeOf('string')
    expect(f('tool_proposed', {})).toContain('?(')
  })
})
