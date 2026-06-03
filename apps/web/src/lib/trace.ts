import type { EventType, ToolStatus, ToolKind } from '@steer/schema'

export interface MessageItem {
  kind: 'message' | 'thinking'
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
}

export type TraceItem = MessageItem | ToolItem

export interface RawEvent {
  seq: number
  type: EventType
  payload: Record<string, unknown>
}

/**
 * Project the append-only event log into renderable trace items. Tool events
 * sharing a toolCallId fold into one card whose status is the latest terminal.
 * Pure and immutable — the UI is a projection of synced state.
 */
export function buildTrace(events: readonly RawEvent[]): TraceItem[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const order: string[] = []
  const messages = new Map<string, MessageItem>()
  const tools = new Map<string, ToolItem>()

  for (const e of sorted) {
    if (e.type === 'message' || e.type === 'thinking') {
      const key = `${e.type[0]}-${e.seq}`
      order.push(key)
      messages.set(key, { kind: e.type, key, text: String(e.payload.text ?? '') })
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
      })
    } else {
      const prev = tools.get(key)
      if (!prev) continue
      if (e.type === 'tool_started') {
        tools.set(key, { ...prev, status: 'running' })
      } else if (e.type === 'tool_result') {
        tools.set(key, { ...prev, status: 'done', result: String(e.payload.result ?? '') })
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

  return order.map((key) => messages.get(key) ?? tools.get(key)).filter((x): x is TraceItem => x !== undefined)
}
