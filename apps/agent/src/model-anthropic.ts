import { anthropic } from '@ai-sdk/anthropic'
import { generateText, tool, type CoreMessage, type ToolSet } from 'ai'
import { toolArgSchemas } from '@steer/schema'
import type { ModelDriver, Step } from './loop.js'
import type { StoredEvent } from './store.js'

const MODEL_IDS: Record<string, string> = {
  sonnet: 'claude-3-5-sonnet-latest',
  opus: 'claude-3-opus-latest',
  haiku: 'claude-3-5-haiku-latest',
}

function buildMessages(task: string | null, events: StoredEvent[]): CoreMessage[] {
  const messages: CoreMessage[] = []
  if (task) messages.push({ role: 'user', content: task })
  for (const e of events) {
    if (e.type === 'message') {
      messages.push({ role: 'assistant', content: (e.payload as { text: string }).text })
    } else if (e.type === 'tool_result' || e.type === 'tool_substituted') {
      const p = e.payload as { name: string; result: string }
      messages.push({ role: 'user', content: `[tool ${p.name} result]\n${p.result}` })
    }
  }
  return messages
}

const toolSet: ToolSet = Object.fromEntries(
  Object.entries(toolArgSchemas).map(([name, parameters]) => [name, tool({ description: name, parameters })]),
)

/**
 * Production model driver — one LLM turn per `next()`. Tools are declared but not
 * auto-executed: the loop owns execution so operators can intercept. External
 * integration boundary (needs an API key); exercised via the live demo, not unit tests.
 */
export function createAnthropicDriver(opts: { model: string; task: string | null }): ModelDriver {
  const modelId = MODEL_IDS[opts.model] ?? opts.model
  return {
    async next(events: StoredEvent[]): Promise<Step> {
      const result = await generateText({
        model: anthropic(modelId),
        system:
          'You are a coding agent. Use the provided tools to inspect and edit the workspace. ' +
          'When the task is complete, reply with a short summary and call no tool.',
        messages: buildMessages(opts.task, events),
        tools: toolSet,
        maxSteps: 1,
      })
      const call = result.toolCalls[0]
      if (call) {
        return {
          t: 'tool',
          toolCallId: call.toolCallId,
          name: call.toolName,
          args: call.args as Record<string, unknown>,
        }
      }
      const text = result.text.trim()
      const lastMessage = [...events].reverse().find((e) => e.type === 'message')
      const lastText = lastMessage ? (lastMessage.payload as { text: string }).text : null
      if (text.length > 0 && text !== lastText) return { t: 'say', text }
      return { t: 'complete' }
    },
  }
}
