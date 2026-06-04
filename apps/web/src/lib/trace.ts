import type { EventType, ToolStatus, ToolKind } from '@steer/schema'

export interface PlanItem {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface MessageItem {
  kind: 'message' | 'thinking' | 'user'
  key: string
  text: string
}

export interface ToolItem {
  kind: 'tool'
  key: string
  toolCallId: string
  name: string
  toolKind: ToolKind
  args: Record<string, unknown>
  status: ToolStatus
  result: string | null
  substitutedFrom: string | null
  /** True when the operator hand-edited the args before this tool ran (U9 audit). */
  editedArgs?: boolean
  /** For file-writing tools: prior + proposed content (U12 diff). */
  before?: string
  after?: string
  /** Child subagent trace items nested under this tool call. */
  children?: TraceItem[]
}

export type TraceItem = MessageItem | ToolItem

export interface RawEvent {
  seq: number
  type: EventType
  payload: Record<string, unknown>
}

function parentToolCallId(event: RawEvent): string | undefined {
  const value = event.payload.parentToolCallId
  return typeof value === 'string' ? value : undefined
}

export function latestPlan(events: readonly RawEvent[]): PlanItem[] | null {
  const sorted = [...events].sort((a, b) => b.seq - a.seq)
  for (const e of sorted) {
    if (e.type !== 'plan') continue
    const items = e.payload.items
    return Array.isArray(items) ? (items as PlanItem[]) : null
  }
  return null
}

/**
 * Project the append-only event log into renderable trace items. Tool events
 * sharing a toolCallId fold into one card whose status is the latest terminal.
 * The session's initial `task` (a session field, not an event) is prepended as
 * the opening "you" turn so the thread reads as a conversation rather than a
 * reply with no question. Pure and immutable — the UI is a projection of state.
 */
export function buildTrace(events: readonly RawEvent[], task?: string | null): TraceItem[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const items = buildTraceLevel(sorted, undefined)
  if (task && task.trim()) {
    return [{ kind: 'user', key: 'task', text: task }, ...items]
  }
  return items
}

function buildTraceLevel(sorted: readonly RawEvent[], parentId: string | undefined): TraceItem[] {
  const levelEvents = sorted.filter((event) => parentToolCallId(event) === parentId)
  const order: string[] = []
  const messages = new Map<string, MessageItem>()
  const tools = new Map<string, ToolItem>()

  for (const e of levelEvents) {
    if (e.type === 'message' || e.type === 'thinking' || e.type === 'user_message') {
      // user_message is the operator's follow-up turn — render it as a user bubble.
      // Annotated so adding a new message-like EventType here fails at the source.
      const kind: MessageItem['kind'] = e.type === 'user_message' ? 'user' : e.type
      const key = `${e.type[0]}-${e.seq}`
      order.push(key)
      messages.set(key, { kind, key, text: String(e.payload.text ?? '') })
      continue
    }

    const toolCallId = e.payload.toolCallId
    if (typeof toolCallId !== 'string') continue
    const key = `tool-${toolCallId}`

    if (e.type === 'tool_proposed') {
      if (!tools.has(key)) order.push(key)
      const toolKind = (e.payload.kind as ToolKind) ?? 'read-only'
      tools.set(key, {
        kind: 'tool',
        key,
        toolCallId,
        name: String(e.payload.name ?? ''),
        toolKind,
        args: (e.payload.args as Record<string, unknown>) ?? {},
        status: toolKind === 'side-effecting' ? 'pending' : 'running',
        result: null,
        substitutedFrom: null,
        ...(typeof e.payload.before === 'string' ? { before: e.payload.before } : {}),
        ...(typeof e.payload.after === 'string' ? { after: e.payload.after } : {}),
      })
    } else {
      const prev = tools.get(key)
      if (!prev) continue
      if (e.type === 'tool_started') {
        tools.set(key, { ...prev, status: 'running' })
      } else if (e.type === 'tool_result') {
        tools.set(key, {
          ...prev,
          status: 'done',
          result: String(e.payload.result ?? ''),
          ...(e.payload.edited === true ? { editedArgs: true } : {}),
        })
      } else if (e.type === 'tool_cancelled') {
        tools.set(key, { ...prev, status: 'cancelled', result: String(e.payload.reason ?? 'cancelled') })
      } else if (e.type === 'tool_substituted') {
        tools.set(key, {
          ...prev,
          status: 'substituted',
          name: String(e.payload.name ?? prev.name),
          result: String(e.payload.result ?? ''),
          substitutedFrom: String(e.payload.from ?? prev.name),
        })
      }
    }
  }

  return order
    .map((key) => messages.get(key) ?? tools.get(key))
    .filter((x): x is TraceItem => x !== undefined)
    .map((item) => {
      if (item.kind !== 'tool') return item
      const children = buildTraceLevel(sorted, item.toolCallId)
      return children.length > 0 ? { ...item, children } : item
    })
}
