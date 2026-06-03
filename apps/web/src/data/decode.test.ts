import { describe, it, expect } from 'vitest'
import { decodeSessionRow, decodeEventRow } from './decode.js'

describe('decodeSessionRow', () => {
  // Exact shape Electric streams (captured from /v1/shape): snake_case columns.
  const synced = {
    id: 'seed-u1-fix-checkout',
    user_id: 'u1',
    title: 'Fix flaky checkout test',
    task: null,
    last_status: 'completed',
    model: 'sonnet',
    created_at: '2026-06-03 14:08:52.17691+00',
    updated_at: '2026-06-03 14:08:52.17691+00',
  }

  it('maps Electric snake_case columns to camelCase', () => {
    const row = decodeSessionRow(synced)
    expect(row.lastStatus).toBe('completed')
    expect(row.userId).toBe('u1')
    expect(row.updatedAt).toBe('2026-06-03 14:08:52.17691+00')
    expect(row.createdAt).toBe('2026-06-03 14:08:52.17691+00')
    expect(row.task).toBeNull()
  })

  it('passes an optimistic camelCase row through unchanged', () => {
    const optimistic = {
      id: 's1',
      userId: '',
      title: 'New task',
      task: 'do the thing',
      lastStatus: 'starting',
      model: 'sonnet',
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
    }
    expect(decodeSessionRow(optimistic).lastStatus).toBe('starting')
    expect(decodeSessionRow(optimistic).updatedAt).toBe('2026-06-03T00:00:00.000Z')
  })

  it('defaults a missing/invalid status to idle (never undefined)', () => {
    expect(decodeSessionRow({ id: 'x' }).lastStatus).toBe('idle')
    expect(decodeSessionRow({ id: 'x', last_status: 42 }).lastStatus).toBe('idle')
  })
})

describe('decodeEventRow', () => {
  // Electric encodes jsonb as a string and integers as strings.
  const synced = {
    session_id: 'seed-u1-fix-checkout',
    seq: '1',
    type: 'tool_proposed',
    payload: '{"name": "grep", "kind": "read-only", "toolCallId": "t1"}',
  }

  it('parses the stringified jsonb payload and coerces seq to a number', () => {
    const row = decodeEventRow(synced)
    expect(row.sessionId).toBe('seed-u1-fix-checkout')
    expect(row.seq).toBe(1)
    expect(typeof row.seq).toBe('number')
    expect(row.payload).toEqual({ name: 'grep', kind: 'read-only', toolCallId: 't1' })
  })

  it('accepts an already-parsed object payload', () => {
    const row = decodeEventRow({ session_id: 's', seq: '0', type: 'message', payload: { text: 'hi' } })
    expect(row.payload).toEqual({ text: 'hi' })
  })

  it('returns an empty object for malformed payload JSON', () => {
    expect(decodeEventRow({ session_id: 's', seq: '0', type: 'message', payload: 'not json' }).payload).toEqual({})
  })
})
