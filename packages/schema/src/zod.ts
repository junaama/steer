import { z } from 'zod'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import {
  sessions,
  events,
  controls,
  SESSION_STATUSES,
  TOOL_STATUSES,
  type EventType,
  type ControlType,
} from './schema.js'
import { READ_ONLY_TOOLS, TOOL_KINDS } from './tools.js'

export const sessionStatusSchema = z.enum(SESSION_STATUSES)
export const toolStatusSchema = z.enum(TOOL_STATUSES)
export const toolKindSchema = z.enum(TOOL_KINDS)

/** Row schemas derived from the drizzle tables — never hand-authored. */
export const sessionInsertSchema = createInsertSchema(sessions)
export const sessionSelectSchema = createSelectSchema(sessions)
export const eventInsertSchema = createInsertSchema(events)
export const controlInsertSchema = createInsertSchema(controls)

const toolRef = z.object({ toolCallId: z.string().min(1), name: z.string().min(1) })

/** Event payload schema keyed by `event.type`. */
export const eventPayloadSchemas = {
  message: z.object({ text: z.string() }),
  thinking: z.object({ text: z.string() }),
  tool_proposed: z.object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    kind: toolKindSchema,
    args: z.record(z.unknown()),
  }),
  tool_started: toolRef,
  tool_stdout_delta: toolRef.extend({ chunk: z.string() }),
  tool_result: toolRef.extend({ result: z.string() }),
  tool_cancelled: toolRef.extend({ reason: z.string().optional() }),
  tool_substituted: toolRef.extend({ from: z.string().min(1), result: z.string() }),
  status_changed: z.object({ status: sessionStatusSchema }),
  interrupted: z.object({ atSeq: z.number().int().nonnegative() }),
} satisfies Record<EventType, z.ZodTypeAny>

const readOnlyToolEnum = z.enum(READ_ONLY_TOOLS as [string, ...string[]])

/** Control payload schema keyed by `control.type`. */
export const controlPayloadSchemas = {
  interrupt: z.object({}).strict(),
  approve: z.object({ toolCallId: z.string().min(1) }),
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
