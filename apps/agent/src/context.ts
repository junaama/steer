import type { StoredEvent } from './store.js'

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

const textOf = (payload: unknown): string => String((payload as { text?: string }).text ?? '')

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
export function buildContext(task: string | null, events: readonly StoredEvent[]): ContextMessage[] {
  const messages: ContextMessage[] = []
  if (task) messages.push({ role: 'user', content: task })
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
