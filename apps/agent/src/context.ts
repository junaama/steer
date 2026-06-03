import type { StoredEvent } from './store.js'

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
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

  for (const e of events) {
    if (e.type === 'message') {
      messages.push({ role: 'assistant', content: String((e.payload as { text?: string }).text ?? '') })
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
