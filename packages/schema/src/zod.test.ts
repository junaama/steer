import { describe, it, expect } from 'vitest'
import { EVENT_TYPES, CONTROL_TYPES } from './schema.js'
import {
  eventPayloadSchemas,
  controlPayloadSchemas,
  parseEventPayload,
  parseControlPayload,
  parseImageAttachment,
  imageAttachmentSchema,
  MAX_IMAGE_BASE64_BYTES,
  sessionInsertSchema,
  sessionSelectSchema,
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

  it('round-trips a child-tagged message payload', () => {
    const p = { text: 'child note', parentToolCallId: 'task1' }
    expect(parseEventPayload('message', p)).toEqual(p)
  })

  it('round-trips a valid message_delta chunk', () => {
    expect(parseEventPayload('message_delta', { text: 'Hel' })).toEqual({ text: 'Hel' })
  })

  it('round-trips a child-tagged message_delta chunk', () => {
    const p = { text: 'lo', parentToolCallId: 'task1' }
    expect(parseEventPayload('message_delta', p)).toEqual(p)
  })

  it('rejects a message_delta missing text', () => {
    expect(() => parseEventPayload('message_delta', {})).toThrow()
  })

  it('rejects an empty message_delta chunk', () => {
    expect(() => parseEventPayload('message_delta', { text: '' })).toThrow()
  })

  it('round-trips a valid thinking_delta chunk', () => {
    expect(parseEventPayload('thinking_delta', { text: 'reasoning…' })).toEqual({ text: 'reasoning…' })
  })

  it('rejects a thinking_delta missing text', () => {
    expect(() => parseEventPayload('thinking_delta', { parentToolCallId: 'task1' })).toThrow()
  })

  it('round-trips a valid tool_proposed payload', () => {
    const p = { toolCallId: 'tc1', name: 'grep', kind: 'read-only', args: { pattern: 'x' } }
    expect(parseEventPayload('tool_proposed', p)).toEqual(p)
  })

  it('round-trips a valid question payload (ask_user, R11)', () => {
    const p = { toolCallId: 'tc1', question: 'Which environment should I deploy to?' }
    expect(parseEventPayload('question', p)).toEqual(p)
  })

  it('rejects a question payload missing the question text', () => {
    expect(() => parseEventPayload('question', { toolCallId: 'tc1' })).toThrow()
  })

  it('rejects a question payload with an empty question', () => {
    expect(() => parseEventPayload('question', { toolCallId: 'tc1', question: '' })).toThrow()
  })

  it('rejects a question payload missing the toolCallId', () => {
    expect(() => parseEventPayload('question', { question: 'where?' })).toThrow()
  })

  it('round-trips subagent lifecycle payloads', () => {
    expect(
      parseEventPayload('subagent_started', {
        parentToolCallId: 'task1',
        description: 'Inspect config',
        prompt: 'Read the config file',
      }),
    ).toEqual({
      parentToolCallId: 'task1',
      description: 'Inspect config',
      prompt: 'Read the config file',
    })
    expect(parseEventPayload('subagent_result', { parentToolCallId: 'task1', summary: 'done' })).toEqual({
      parentToolCallId: 'task1',
      summary: 'done',
    })
  })

  it('round-trips a valid plan payload with each todo status', () => {
    const p = {
      items: [
        { text: 'write tests', status: 'pending' },
        { text: 'implement tool', status: 'in_progress' },
        { text: 'verify coverage', status: 'done' },
      ],
    }
    expect(parseEventPayload('plan', p)).toEqual(p)
  })

  it('rejects a plan item with an invalid status', () => {
    expect(() => parseEventPayload('plan', { items: [{ text: 'write tests', status: 'blocked' }] })).toThrow()
  })

  it('rejects a plan item missing text', () => {
    expect(() => parseEventPayload('plan', { items: [{ status: 'pending' }] })).toThrow()
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

  it('round-trips a child-tagged tool_result', () => {
    const p = { toolCallId: 'tc1', name: 'read_file', result: 'contents', parentToolCallId: 'task1' }
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

describe('image attachment (R14, vision input)', () => {
  const tinyBase64 = 'iVBORw0KGgo' // a valid base64 fragment

  it('round-trips a valid image/* attachment', () => {
    const img = { mediaType: 'image/png', dataBase64: tinyBase64 }
    expect(parseImageAttachment(img)).toEqual(img)
  })

  it('accepts other image/* MIME types', () => {
    expect(parseImageAttachment({ mediaType: 'image/jpeg', dataBase64: tinyBase64 }).mediaType).toBe('image/jpeg')
    expect(parseImageAttachment({ mediaType: 'image/svg+xml', dataBase64: tinyBase64 }).mediaType).toBe('image/svg+xml')
  })

  it('rejects a non-image MIME type', () => {
    expect(() => parseImageAttachment({ mediaType: 'text/plain', dataBase64: tinyBase64 })).toThrow()
    expect(() => parseImageAttachment({ mediaType: 'application/pdf', dataBase64: tinyBase64 })).toThrow()
  })

  it('rejects an empty data payload', () => {
    expect(() => parseImageAttachment({ mediaType: 'image/png', dataBase64: '' })).toThrow()
  })

  it('rejects data that is not valid base64', () => {
    expect(() => parseImageAttachment({ mediaType: 'image/png', dataBase64: 'not base64!!' })).toThrow()
  })

  it('rejects unknown extra keys (strict)', () => {
    expect(() =>
      parseImageAttachment({ mediaType: 'image/png', dataBase64: tinyBase64, extra: 'x' }),
    ).toThrow()
  })

  it('accepts an image exactly at the size cap', () => {
    const atCap = 'a'.repeat(MAX_IMAGE_BASE64_BYTES)
    expect(parseImageAttachment({ mediaType: 'image/png', dataBase64: atCap }).dataBase64.length).toBe(
      MAX_IMAGE_BASE64_BYTES,
    )
  })

  it('rejects an over-cap image with a clear message', () => {
    const overCap = 'a'.repeat(MAX_IMAGE_BASE64_BYTES + 1)
    const result = imageAttachmentSchema.safeParse({ mediaType: 'image/png', dataBase64: overCap })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('size cap'))).toBe(true)
    }
  })

  it('rejects a missing mediaType or dataBase64', () => {
    expect(() => parseImageAttachment({ dataBase64: tinyBase64 })).toThrow()
    expect(() => parseImageAttachment({ mediaType: 'image/png' })).toThrow()
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

  it('accepts environment and claimed_by on a session insert', () => {
    const r = sessionInsertSchema.parse({
      id: 's1',
      userId: 'u1',
      title: 'Add auth',
      environment: 'laptop',
      claimedBy: 'laptop',
    })
    expect(r.environment).toBe('laptop')
    expect(r.claimedBy).toBe('laptop')
  })

  it('treats environment and claimed_by as optional/nullable on insert', () => {
    const r = sessionInsertSchema.parse({ id: 's1', userId: 'u1', title: 't' })
    expect(r.environment ?? null).toBeNull()
    expect(r.claimedBy ?? null).toBeNull()
  })

  it('round-trips environment and claimed_by on a selected session row', () => {
    const r = sessionSelectSchema.parse({
      id: 's1',
      userId: 'u1',
      title: 'Add auth',
      task: null,
      lastStatus: 'starting',
      model: 'sonnet',
      environment: 'laptop',
      claimedBy: 'laptop',
      workdir: '/dev/app',
      taskImage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(r.environment).toBe('laptop')
    expect(r.claimedBy).toBe('laptop')
    expect(r.workdir).toBe('/dev/app')
  })

  it('accepts null environment and claimed_by on a selected session row', () => {
    const r = sessionSelectSchema.parse({
      id: 's1',
      userId: 'u1',
      title: 'Add auth',
      task: null,
      lastStatus: 'idle',
      model: 'sonnet',
      environment: null,
      claimedBy: null,
      workdir: null,
      taskImage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(r.environment).toBeNull()
    expect(r.claimedBy).toBeNull()
    expect(r.workdir).toBeNull()
  })

  it('round-trips a task_image attachment on a selected session row (R14)', () => {
    const taskImage = { mediaType: 'image/png', dataBase64: 'iVBORw0KGgo' }
    const r = sessionSelectSchema.parse({
      id: 's1',
      userId: 'u1',
      title: 'Add auth',
      task: 'fix this layout',
      lastStatus: 'starting',
      model: 'sonnet',
      environment: null,
      claimedBy: null,
      workdir: null,
      taskImage,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(r.taskImage).toEqual(taskImage)
  })
})
