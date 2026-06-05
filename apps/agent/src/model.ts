import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { streamText, jsonSchema, tool, type CoreMessage, type LanguageModel, type ToolSet } from 'ai'
import { toolArgSchemas, TOOL_DESCRIPTIONS, type ToolName } from '@steer/schema'
import type { ModelDriver, ToolCall, TurnHooks, TurnResult } from './loop.js'
import type { StoredEvent } from './store.js'
import { buildContext } from './context.js'
import { resolveProvider, resolveModelId, type Provider } from './provider.js'
import { tracingEnabled } from './tracing.js'
import type { SubagentDriverInput } from './subagent.js'

export interface DynamicToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

type JsonSchemaInput = Parameters<typeof jsonSchema<Record<string, unknown>>>[0]

function createToolSet(names?: readonly string[], dynamicTools: readonly DynamicToolDefinition[] = []): ToolSet {
  const allowed = names ? new Set(names) : null
  // Tools are declared WITHOUT an `execute` fn: the AI SDK then returns tool
  // calls to the caller instead of running them, so the loop keeps ownership of
  // execution and the per-tool approval gate.
  const staticTools = Object.entries(toolArgSchemas)
    .filter(([name]) => allowed === null || allowed.has(name))
    .map(([name, parameters]) => [name, tool({ description: TOOL_DESCRIPTIONS[name as ToolName] ?? name, parameters })] as const)
  const mcpTools = dynamicTools
    .filter((definition) => allowed === null || allowed.has(definition.name))
    .map(
      (definition) =>
        [
          definition.name,
          tool({
            description: definition.description,
            parameters: jsonSchema<Record<string, unknown>>(definition.inputSchema as JsonSchemaInput),
          }),
        ] as const,
  )
  return Object.fromEntries([...staticTools, ...mcpTools])
}

const toolSet = createToolSet()

const SYSTEM_PROMPT =
  'You are a coding agent. Work the task to a verified, finished state — plan, act, then VERIFY; do not give up early or stop at a partial answer. ' +
  'Make a brief plan, then use the provided tools to inspect and edit the workspace. You may call SEVERAL tools in one turn — batch independent reads (grep, glob, read_file, list_dir) together to move faster. ' +
  'Think out loud as you go: your reasoning streams to the operator, so explain what you are about to do and why. ' +
  'To find information or pages online, call web_search with a query and then web_fetch the top 3 result URLs to compare before answering — never guess, invent, or assume a URL. ' +
  'To find things on disk, use grep / glob / list_dir, or bash for a broad filesystem search (find, grep -r). ' +
  'Search by the bare identifier (e.g. `slugify`), not a language keyword like `def` or `function`, and do not assume the file extension. ' +
  'If a file or folder is not at the path you expect, do NOT give up or ask the user to check — locate it with a single glob matching its name (e.g. glob `widget` or `README`) or a grep, rather than walking directories one by one, before concluding it does not exist. ' +
  'Treat the whole conversation as one task: when the user later gives a correction or a missing detail (such as a path or filename), use it to COMPLETE the original request — do not just describe what you found or restate their message; keep working until the original question is actually answered. ' +
  'Prefer edit_file or multi_edit over write_file for existing files. ' +
  'After ANY edit, VERIFY it: run the project tests or build with run_command, read the failures, and keep fixing and re-running until verification passes — never report an edit as done without running it. ' +
  'As soon as a tool result answers the question, stop calling tools. ' +
  'When the task is complete — or as soon as you have the answer — reply with a short summary that names the exact file paths and identifiers involved, and call no tool.'

function selectModel(provider: Provider, modelId: string): LanguageModel {
  return provider === 'openai' ? openai(modelId) : anthropic(modelId)
}

/**
 * Vercel AI SDK → Langfuse trace settings for one model call. A no-op unless
 * tracing is enabled (so production is unaffected); when on, it links each call
 * to its Steer session so Langfuse groups a session's calls into one trace.
 */
function telemetry(functionId: string, events: StoredEvent[]) {
  const sessionId = events[0]?.sessionId
  return {
    isEnabled: tracingEnabled(),
    functionId,
    ...(sessionId ? { metadata: { langfuseSessionId: sessionId } } : {}),
  }
}

/**
 * Consume `streamText`'s fullStream for one turn: route reasoning/text deltas to
 * the loop's hooks as they arrive, collect the tool-call batch, and coalesce the
 * full text/reasoning for the terminal events. Tools are declared without
 * `execute`, so `tool-call` parts surface here for the loop to run through the gate.
 */
async function streamTurn(
  llm: LanguageModel,
  system: string,
  messages: CoreMessage[],
  tools: ToolSet,
  functionId: string,
  events: StoredEvent[],
  hooks: TurnHooks,
): Promise<TurnResult> {
  const result = streamText({
    experimental_telemetry: telemetry(functionId, events),
    model: llm,
    system,
    messages,
    tools,
  })
  let text = ''
  let reasoning = ''
  const toolCalls: ToolCall[] = []
  for await (const part of result.fullStream) {
    if (part.type === 'reasoning') {
      reasoning += part.textDelta
      hooks.onReasoningDelta?.(part.textDelta)
    } else if (part.type === 'text-delta') {
      text += part.textDelta
      hooks.onTextDelta?.(part.textDelta)
    } else if (part.type === 'tool-call') {
      toolCalls.push({
        toolCallId: part.toolCallId,
        name: part.toolName,
        args: part.args as Record<string, unknown>,
      })
    }
  }
  return { text, reasoning, toolCalls }
}

/**
 * Production model driver — provider-agnostic, streaming. The provider (OpenAI or
 * Anthropic) is resolved from env; tools are declared but not auto-executed so the
 * loop owns execution and operators can intercept. One `next` streams a turn's
 * reasoning/text deltas and returns the full tool-call batch. External integration
 * boundary (needs an API key); exercised via the live demo, not unit tests.
 */
export function createModelDriver(opts: {
  model: string
  task: string | null
  /** Restrict the declared toolset (e.g. READ_ONLY_TOOLS for unattended evals). */
  tools?: readonly string[]
  dynamicTools?: readonly DynamicToolDefinition[]
}): ModelDriver {
  const provider = resolveProvider(process.env)
  const modelId = resolveModelId(provider, opts.model, process.env)
  const llm = selectModel(provider, modelId)
  const tools =
    opts.tools || (opts.dynamicTools && opts.dynamicTools.length > 0)
      ? createToolSet(opts.tools, opts.dynamicTools ?? [])
      : toolSet

  return {
    next(events: StoredEvent[], _cursor: number, hooks: TurnHooks): Promise<TurnResult> {
      const messages = buildContext(opts.task, events) as CoreMessage[]
      return streamTurn(llm, SYSTEM_PROMPT, messages, tools, 'agent.turn', events, hooks)
    },
  }
}

export function createSubagentDriver(
  opts: { model: string; dynamicTools?: readonly DynamicToolDefinition[] } & SubagentDriverInput,
): ModelDriver {
  const provider = resolveProvider(process.env)
  const modelId = resolveModelId(provider, opts.model, process.env)
  const llm = selectModel(provider, modelId)
  const scopedToolSet = createToolSet(opts.tools, opts.dynamicTools)
  const system =
    `You are a scoped child coding agent delegated to: ${opts.description}. ` +
    'Use only the provided tools. You may batch independent reads in one turn. Think out loud as you work, ' +
    'keep the work bounded to the sub-task, verify any edits you make, and finish with a concise summary.'

  return {
    next(events: StoredEvent[], _cursor: number, hooks: TurnHooks): Promise<TurnResult> {
      const messages = buildContext(opts.prompt, events) as CoreMessage[]
      return streamTurn(llm, system, messages, scopedToolSet, 'subagent.turn', events, hooks)
    },
  }
}
