import { describe, it, expect } from 'vitest'
import { EVENT_TYPES, CONTROL_TYPES } from './schema.js'
import {
  eventPayloadSchemas,
  controlPayloadSchemas,
  parseEventPayload,
  parseControlPayload,
  sessionInsertSchema,
} from './zod.js'

describe('event payloads', () => {
  it('has a schema for every event type', () => {
    for (const type of EVENT_TYPES) {
      expect(eventPayloadSchemas[type]).toBeDefined()
    }
  })

  it('round-trips a valid message payload', () => {
    expect(parseEventPayload('message', { text: 'hello' })).toEqual({ text: 'hello' })
  })

  it('round-trips a valid tool_proposed payload', () => {
    const p = { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: { pattern: 'x' } }
    expect(parseEventPayload('tool_proposed', p)).toEqual(p)
  })

  it('rejects an invalid tool_proposed payload (bad kind)', () => {
    expect(() =>
      parseEventPayload('tool_proposed', { toolCallId: 'tc1', name: 'grep', kind: 'nope', args: {} }),
    ).toThrow()
  })

  it('rejects a tool_result without a result string', () => {
    expect(() => parseEventPayload('tool_result', { toolCallId: 'tc1', name: 'grep' })).toThrow()
  })

  it('round-trips a tool_result carrying the edited audit flag', () => {
    const p = { toolCallId: 'tc1', name: 'read_file', result: 'contents', edited: true }
    expect(parseEventPayload('tool_result', p)).toEqual(p)
  })

  it('treats edited as optional on tool_result', () => {
    const p = { toolCallId: 'tc1', name: 'grep', result: 'm' }
    expect(parseEventPayload('tool_result', p)).toEqual(p)
  })

  it('rejects a non-boolean edited flag', () => {
    expect(() =>
      parseEventPayload('tool_result', { toolCallId: 'tc1', name: 'grep', result: 'm', edited: 'yes' }),
    ).toThrow()
  })
})

describe('control payloads', () => {
  it('has a schema for every control type', () => {
    for (const type of CONTROL_TYPES) {
      expect(controlPayloadSchemas[type]).toBeDefined()
    }
  })

  it('accepts a substitution to a read-only tool', () => {
    expect(parseControlPayload('override', { toolCallId: 'tc1', newTool: 'read_file' })).toMatchObject({
      toolCallId: 'tc1',
      newTool: 'read_file',
    })
  })

  it('rejects a substitution to a side-effecting tool (INT-R6)', () => {
    expect(() =>
      parseControlPayload('override', { toolCallId: 'tc1', newTool: 'write_file' }),
    ).toThrow()
    expect(() => parseControlPayload('override', { toolCallId: 'tc1', newTool: 'bash' })).toThrow()
  })

  it('rejects an override that changes nothing', () => {
    expect(() => parseControlPayload('override', { toolCallId: 'tc1' })).toThrow()
  })

  it('accepts an arg-only edit', () => {
    expect(parseControlPayload('override', { toolCallId: 'tc1', newArgs: { path: 'src/x.ts' } })).toMatchObject(
      { toolCallId: 'tc1' },
    )
  })

  it('interrupt payload is empty and strict', () => {
    expect(parseControlPayload('interrupt', {})).toEqual({})
    expect(() => parseControlPayload('interrupt', { extra: 1 })).toThrow()
  })

  it('accepts approve payloads with an optional alwaysAllow grant', () => {
    expect(parseControlPayload('approve', { toolCallId: 'tc1', alwaysAllow: true })).toEqual({
      toolCallId: 'tc1',
      alwaysAllow: true,
    })
    expect(parseControlPayload('approve', { toolCallId: 'tc1' })).toEqual({ toolCallId: 'tc1' })
    expect(() => parseControlPayload('approve', { toolCallId: 'tc1', alwaysAllow: 'yes' })).toThrow()
  })
})

describe('drizzle-zod row schemas', () => {
  it('accepts a valid session insert', () => {
    const r = sessionInsertSchema.parse({ id: 's1', userId: 'u1', title: 'Add auth' })
    expect(r.id).toBe('s1')
  })

  it('rejects a session insert missing required fields', () => {
    expect(() => sessionInsertSchema.parse({ id: 's1' })).toThrow()
  })
})
