import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { streamText, jsonSchema, tool, type CoreMessage, type LanguageModel, type ToolSet } from 'ai'
import { toolArgSchemas, TOOL_DESCRIPTIONS, type ToolName, type ImageAttachment } from '@steer/schema'
import type { ModelDriver, ToolCall, TurnHooks, TurnResult } from './loop.js'
import type { StoredEvent } from './store.js'
import { buildContext } from './context.js'
import { resolveProvider, resolveModelId, providerSupportsVision, type Provider } from './provider.js'
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

// Organized by principle, not appended per-bug. Keep it tight: add a new line
// only when it states a PRINCIPLE that earns its place, and fold/merge rather
// than grow. Behaviors here are guarded by the eval goldens (evals/goldens.ts).
const SYSTEM_PROMPT =
  'You are a coding agent. Work each task to a verified, finished state: plan briefly, act with the tools, then verify — never give up early or hand back a partial answer. ' +
  'You may call several tools in one turn — batch independent reads (read_file, grep, glob, list_dir) to move faster. Think out loud as you go; your reasoning streams to the operator. ' +
  // Groundedness — the core principle. Replaces ad-hoc "don\'t speculate" patches.
  'Ground EVERYTHING in what you actually read or ran — never speculate. Do not describe a file you have not opened: hedging words like "likely", "probably", "possibly", or "might contain" mean you are guessing, so open the file and state what it ACTUALLY contains instead. To summarize, explain, or review code or a directory, READ the relevant files first (READMEs, docs, entry points, configs, a representative sample of the source) — a directory listing is where you START, never the basis for an answer. ' +
  'Finding things on disk: grep / glob / list_dir, or bash (find, grep -r) for a broad sweep. Search by the bare identifier (e.g. `slugify`), not a keyword like `def` or `function`, and do not assume the extension. If something is not where you expect, locate it with a glob or grep before concluding it is absent — do not give up or ask the operator to check. ' +
  'Online lookups: web_search, then web_fetch the top results to compare before answering — never invent a URL. ' +
  'Editing: prefer edit_file / multi_edit over write_file for existing files. After ANY edit, verify it by running the project tests or build with run_command, read the failures, and keep fixing until it passes — never report an edit as done without running it. ' +
  'Treat the whole conversation as one task: use a later correction or detail to COMPLETE the original request, not just to restate it. If a genuinely required detail is missing and you cannot find it by searching, call ask_user with ONE specific question and wait — reserve it for true blockers, not for details you can find yourself. ' +
  'Stop calling tools once you have gathered the evidence the answer genuinely requires — a lookup may need a single result; a summary, explanation, or review means having READ the files, not merely listed them. Finish with a concise summary grounded in what you read, naming the exact file paths and identifiers involved.'

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
  /** An operator-attached image on the initial task (R14); projected only when the resolved model has vision. */
  taskImage?: ImageAttachment | null
  /** Restrict the declared toolset (e.g. READ_ONLY_TOOLS for unattended evals). */
  tools?: readonly string[]
  dynamicTools?: readonly DynamicToolDefinition[]
}): ModelDriver {
  const provider = resolveProvider(process.env)
  const modelId = resolveModelId(provider, opts.model, process.env)
  const llm = selectModel(provider, modelId)
  // Feature-detect vision once per driver: project the attached image as an image
  // content part only on a vision-capable model; otherwise buildContext drops it
  // and notes the omission (R14 graceful degradation).
  const vision = providerSupportsVision(provider, modelId)
  const tools =
    opts.tools || (opts.dynamicTools && opts.dynamicTools.length > 0)
      ? createToolSet(opts.tools, opts.dynamicTools ?? [])
      : toolSet

  return {
    next(events: StoredEvent[], _cursor: number, hooks: TurnHooks): Promise<TurnResult> {
      const messages = buildContext(opts.task, events, { taskImage: opts.taskImage, vision }) as CoreMessage[]
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
