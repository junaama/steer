import type { ImageAttachment } from '@steer/schema'
import type { StoredEvent } from './store.js'

/** A text content part — the AI SDK v4 `TextPart` shape. */
export interface TextPart {
  type: 'text'
  text: string
}

/**
 * An image content part — the AI SDK v4 `ImagePart` shape. `image` is a data URL
 * (`data:<mediaType>;base64,<bytes>`) the SDK forwards to a vision-capable model.
 */
export interface ImagePart {
  type: 'image'
  image: string
}

export type ContentPart = TextPart | ImagePart

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system'
  // A plain string for text turns, or an array of content parts when the turn
  // carries an image alongside text (R14). The AI SDK accepts both for a user role.
  content: string | ContentPart[]
}

/**
 * Options for projecting the event log. `taskImage` is the optional image the
 * operator attached to the initial task (R14); `vision` says whether the resolved
 * provider/model can read it. The image is projected as an image content part on
 * the leading task message ONLY when both are present — otherwise it is dropped
 * (and noted) so a text-only model is never sent an image part it would reject.
 */
export interface ContextOptions {
  taskImage?: ImageAttachment | null
  vision?: boolean
}

const textOf = (payload: unknown): string => String((payload as { text?: string }).text ?? '')

/** Assemble the `data:` URL the AI SDK forwards as an image content part. */
function imageDataUrl(image: ImageAttachment): string {
  return `data:${image.mediaType};base64,${image.dataBase64}`
}

/**
 * Build the leading task message. With a vision-capable model and an attached
 * image, the task becomes a multi-part user message (text + image part) the SDK
 * sends to the model (R14). Without vision (or without an image) it stays a plain
 * text user message; a present-but-undisplayable image adds a short system note so
 * the model knows an image existed but could not be read — graceful degradation,
 * never a throw.
 */
function buildTaskMessages(task: string, opts: ContextOptions): ContextMessage[] {
  const image = opts.taskImage ?? null
  if (image && opts.vision) {
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: task },
          { type: 'image', image: imageDataUrl(image) },
        ],
      },
    ]
  }
  const messages: ContextMessage[] = [{ role: 'user', content: task }]
  if (image) {
    messages.push({
      role: 'system',
      content: '[image omitted — the selected model has no vision support]',
    })
  }
  return messages
}

type PlanItem = { text: string; status: 'pending' | 'in_progress' | 'done' }

function latestPlanItems(events: readonly StoredEvent[]): PlanItem[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'plan') continue
    const payload = event.payload as { items?: unknown }
    return Array.isArray(payload.items) ? (payload.items as PlanItem[]) : null
  }
  return null
}

/**
 * Project the event log into the LLM context. After an override, the executed
 * (substituted) tool appears as *the* call, and a system note records the
 * operator's substitution — so the model adapts on its normal next turn with no
 * extra re-planning inference and an unchanged prompt prefix.
 */
export function buildContext(
  task: string | null,
  events: readonly StoredEvent[],
  options: ContextOptions = {},
): ContextMessage[] {
  const messages: ContextMessage[] = []
  if (task) messages.push(...buildTaskMessages(task, options))
  const plan = latestPlanItems(events)
  if (plan) {
    const lines = plan.map((item) => `- [${item.status}] ${item.text}`)
    messages.push({ role: 'system', content: `Current todo list:\n${lines.join('\n')}` })
  }

  for (const e of events) {
    if (e.type === 'message') {
      messages.push({ role: 'assistant', content: textOf(e.payload) })
    } else if (e.type === 'user_message') {
      // A follow-up turn from the operator — continues the conversation.
      messages.push({ role: 'user', content: textOf(e.payload) })
    } else if (e.type === 'tool_result') {
      const p = e.payload as { name: string; result: string }
      messages.push({ role: 'user', content: `[tool ${p.name} result]\n${p.result}` })
    } else if (e.type === 'tool_substituted') {
      const p = e.payload as { name: string; from: string; result: string }
      messages.push({ role: 'system', content: `[operator substituted ${p.from} → ${p.name}]` })
      messages.push({ role: 'user', content: `[tool ${p.name} result]\n${p.result}` })
    }
  }
  return messages
}
