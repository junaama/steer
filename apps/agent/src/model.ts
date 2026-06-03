import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { generateText, tool, type CoreMessage, type LanguageModel, type ToolSet } from 'ai'
import { toolArgSchemas } from '@steer/schema'
import type { ModelDriver, Step } from './loop.js'
import type { StoredEvent } from './store.js'
import { buildContext } from './context.js'
import { decideStep } from './decide.js'
import { resolveProvider, resolveModelId, type Provider } from './provider.js'

const toolSet: ToolSet = Object.fromEntries(
  Object.entries(toolArgSchemas).map(([name, parameters]) => [name, tool({ description: name, parameters })]),
)

function selectModel(provider: Provider, modelId: string): LanguageModel {
  return provider === 'openai' ? openai(modelId) : anthropic(modelId)
}

/**
 * Production model driver — provider-agnostic. The provider (OpenAI or Anthropic)
 * is resolved from env; tools are declared but not auto-executed so the loop owns
 * execution and operators can intercept. External integration boundary (needs an
 * API key); exercised via the live demo, not unit tests.
 */
export function createModelDriver(opts: { model: string; task: string | null }): ModelDriver {
  const provider = resolveProvider(process.env)
  const modelId = resolveModelId(provider, opts.model, process.env)
  const llm = selectModel(provider, modelId)

  return {
    async next(events: StoredEvent[]): Promise<Step> {
      const messages = buildContext(opts.task, events) as CoreMessage[]
      const result = await generateText({
        model: llm,
        system:
          'You are a coding agent. Make a brief plan, then use the provided tools to inspect and edit the workspace. ' +
          'Prefer edit_file or multi_edit over write_file for existing files. After any edit, run the project tests or build with run_command, read the failures, and keep fixing until verification passes. ' +
          'When the task is truly complete, reply with a short summary and call no tool.',
        messages,
        tools: toolSet,
        maxSteps: 1,
      })
      const call = result.toolCalls[0]
      return decideStep(events, {
        toolCall: call
          ? { toolCallId: call.toolCallId, name: call.toolName, args: call.args as Record<string, unknown> }
          : undefined,
        text: result.text,
      })
    },
  }
}
