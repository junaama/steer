import { z } from 'zod'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import {
  sessions,
  events,
  controls,
  SESSION_STATUSES,
  EVENT_TYPES,
  CONTROL_TYPES,
  TOOL_STATUSES,
  type EventType,
  type ControlType,
} from './schema.js'
import { READ_ONLY_TOOLS, TOOL_KINDS } from './tools.js'

export const sessionStatusSchema = z.enum(SESSION_STATUSES)
export const eventTypeSchema = z.enum(EVENT_TYPES)
export const controlTypeSchema = z.enum(CONTROL_TYPES)
export const toolStatusSchema = z.enum(TOOL_STATUSES)
export const toolKindSchema = z.enum(TOOL_KINDS)

/**
 * Size cap on an attached image's base64 payload (R14). There is no object store
 * and the image rides a Postgres row that Electric syncs out to the daemon, so an
 * unbounded image would bloat both the DB and every sync — see the plan's Risks.
 * ~1.5 MB of base64 ≈ ~1.1 MB of raw image, comfortably enough for a screenshot,
 * an error capture, or a design mock while keeping the synced row bounded. Both
 * the server write boundary and the web composer enforce this same constant.
 */
export const MAX_IMAGE_BASE64_BYTES = 1_500_000

// Standard base64 alphabet (with optional `=` padding). Validating the encoding
// up front means the server never persists a malformed payload that the provider
// SDK would later reject mid-turn.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * A validated operator-attached image (R14). `mediaType` must be an `image/*`
 * MIME type (never log or trust an arbitrary type), and `dataBase64` must be
 * non-empty, validly base64-encoded, and within the size cap. Used on session
 * create (the initial task) and enforced at the server write boundary; an
 * over-cap or non-image payload is rejected with a clear message rather than
 * persisted. The byte length is measured on the base64 string itself (what the
 * row actually stores), so the cap bounds the synced payload directly.
 */
export const imageAttachmentSchema = z
  .object({
    mediaType: z
      .string()
      .regex(/^image\/[-+.\w]+$/, { message: 'mediaType must be an image/* MIME type' }),
    dataBase64: z
      .string()
      .min(1, { message: 'image data must not be empty' })
      .regex(BASE64_RE, { message: 'image data must be valid base64' }),
  })
  .strict()
  .refine((img) => img.dataBase64.length <= MAX_IMAGE_BASE64_BYTES, {
    message: `image exceeds the ${MAX_IMAGE_BASE64_BYTES}-byte base64 size cap`,
    path: ['dataBase64'],
  })

export type ImageAttachmentInput = z.infer<typeof imageAttachmentSchema>

/**
 * Parse + validate an attached image, throwing a `ZodError` on a malformed,
 * non-image, or over-cap payload. The single entry point the server write
 * boundary uses so the cap and `image/*` rule are enforced in exactly one place.
 */
export function parseImageAttachment(input: unknown): ImageAttachmentInput {
  return imageAttachmentSchema.parse(input)
}

/** Row schemas derived from the drizzle tables — never hand-authored. */
export const sessionInsertSchema = createInsertSchema(sessions)
export const sessionSelectSchema = createSelectSchema(sessions)
export const eventInsertSchema = createInsertSchema(events)
export const controlInsertSchema = createInsertSchema(controls)

const toolRef = z.object({ toolCallId: z.string().min(1), name: z.string().min(1) })
const childTag = z.object({ parentToolCallId: z.string().min(1).optional() })
const childToolRef = toolRef.merge(childTag)
const textPayload = z.object({ text: z.string() })
const childTextPayload = textPayload.merge(childTag)
// Streamed assistant text/reasoning chunk. Mirrors the `message`/`thinking`
// child-tagged text shape, but a delta carries a non-empty chunk (an empty
// chunk is never worth a row — it would just be coalescer noise).
const deltaTextPayload = z.object({ text: z.string().min(1) }).merge(childTag)
export const planItemSchema = z.object({
  text: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done']),
})

/** Event payload schema keyed by `event.type`. */
export const eventPayloadSchemas = {
  message: childTextPayload,
  // A coarse streamed chunk of the assistant's reply, coalesced into a terminal
  // `message` on turn finish (non-terminal — see loop.ts TERMINAL_TYPES).
  message_delta: deltaTextPayload,
  // A follow-up instruction the user sends to an existing session (multi-turn).
  user_message: textPayload,
  thinking: childTextPayload,
  // A coarse streamed chunk of the assistant's reasoning, coalesced into a
  // terminal `thinking` on turn finish (non-terminal — see loop.ts TERMINAL_TYPES).
  thinking_delta: deltaTextPayload,
  tool_proposed: z
    .object({
      toolCallId: z.string().min(1),
      name: z.string().min(1),
      kind: toolKindSchema,
      args: z.record(z.unknown()),
      // For file-writing tools: prior + proposed content so the UI renders a diff.
      before: z.string().optional(),
      after: z.string().optional(),
    })
    .merge(childTag),
  tool_started: childToolRef,
  tool_stdout_delta: toolRef.extend({ chunk: z.string() }),
  // `edited` marks a result the operator ran with hand-edited args (U9 audit).
  tool_result: childToolRef.extend({ result: z.string(), edited: z.boolean().optional() }),
  tool_cancelled: childToolRef.extend({ reason: z.string().optional() }),
  tool_substituted: childToolRef.extend({ from: z.string().min(1), result: z.string() }),
  // The agent's clarifying question (R11) tied to the asking `ask_user` tool call
  // by its id, so the UI can surface it and an operator answer routes back to that
  // call. Only the id + question (not the tool `name`) is needed to render it.
  question: z.object({ toolCallId: z.string().min(1), question: z.string().min(1) }).merge(childTag),
  subagent_started: z.object({
    parentToolCallId: z.string().min(1),
    description: z.string(),
    prompt: z.string(),
  }),
  subagent_result: z.object({
    parentToolCallId: z.string().min(1),
    summary: z.string(),
  }),
  plan: z.object({ items: z.array(planItemSchema) }),
  status_changed: z.object({ status: sessionStatusSchema }),
  interrupted: z.object({ atSeq: z.number().int().nonnegative() }),
} satisfies Record<EventType, z.ZodTypeAny>

const readOnlyToolEnum = z.enum(READ_ONLY_TOOLS as [string, ...string[]])

/** Control payload schema keyed by `control.type`. */
export const controlPayloadSchemas = {
  interrupt: z.object({}).strict(),
  approve: z.object({ toolCallId: z.string().min(1), alwaysAllow: z.boolean().optional() }),
  reject: z.object({ toolCallId: z.string().min(1) }),
  // A substitute tool MUST be read-only (INT-R6) — enforced at the schema level.
  override: z
    .object({
      toolCallId: z.string().min(1),
      newTool: readOnlyToolEnum.optional(),
      newArgs: z.record(z.unknown()).optional(),
    })
    .refine((v) => v.newTool !== undefined || v.newArgs !== undefined, {
      message: 'override must change the tool, the args, or both',
    }),
} satisfies Record<ControlType, z.ZodTypeAny>

export function parseEventPayload<T extends EventType>(
  type: T,
  payload: unknown,
): z.infer<(typeof eventPayloadSchemas)[T]> {
  return eventPayloadSchemas[type].parse(payload) as z.infer<(typeof eventPayloadSchemas)[T]>
}

export function parseControlPayload<T extends ControlType>(
  type: T,
  payload: unknown,
): z.infer<(typeof controlPayloadSchemas)[T]> {
  return controlPayloadSchemas[type].parse(payload) as z.infer<(typeof controlPayloadSchemas)[T]>
}
