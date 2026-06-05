import { z } from 'zod'

const todoItemSchema = z.object({
  text: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done']),
})

const lspPositionSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
})

/**
 * Tool registry, argument schemas, and the read-only vs side-effecting policy.
 * This is the single source of truth the agent's Vercel AI SDK tool defs, the
 * server's validation, and the UI's swap picker all consume.
 */

export const TOOL_KINDS = ['read-only', 'side-effecting'] as const
export type ToolKind = (typeof TOOL_KINDS)[number]

/** Argument schemas per tool. */
export const toolArgSchemas = {
  read_file: z.object({ path: z.string().min(1), range: z.string().optional() }),
  list_dir: z.object({ path: z.string().min(1), depth: z.number().int().min(1).max(10).optional() }),
  grep: z.object({ pattern: z.string().min(1), path: z.string().min(1), flags: z.string().optional() }),
  glob: z.object({ pattern: z.string().min(1) }),
  web_search: z.object({ query: z.string().min(1) }),
  web_fetch: z.object({ url: z.string().url() }),
  todo_write: z.object({ items: z.array(todoItemSchema) }),
  diagnostics: z.object({ path: z.string().min(1) }),
  definition: lspPositionSchema,
  references: lspPositionSchema,
  hover: lspPositionSchema,
  write_file: z.object({ path: z.string().min(1), content: z.string() }),
  edit_file: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() }),
  multi_edit: z.object({
    path: z.string().min(1),
    edits: z.array(z.object({ old_string: z.string().min(1), new_string: z.string() })),
  }),
  bash: z.object({ command: z.string().min(1) }),
  run_command: z.object({ command: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
  task: z.object({
    description: z.string().min(1),
    prompt: z.string().min(1),
    tools: z.array(z.string().min(1)).optional(),
  }),
  ask_user: z.object({ question: z.string().min(1) }),
} as const

export type ToolName = keyof typeof toolArgSchemas

/** read-only tools are swap-eligible and cancellable mid-execution. */
export const TOOL_POLICY: Record<ToolName, ToolKind> = {
  read_file: 'read-only',
  list_dir: 'read-only',
  grep: 'read-only',
  glob: 'read-only',
  web_search: 'read-only',
  web_fetch: 'read-only',
  todo_write: 'read-only',
  diagnostics: 'read-only',
  definition: 'read-only',
  references: 'read-only',
  hover: 'read-only',
  write_file: 'side-effecting',
  edit_file: 'side-effecting',
  multi_edit: 'side-effecting',
  bash: 'side-effecting',
  run_command: 'side-effecting',
  task: 'side-effecting',
  // ask_user blocks the run waiting for an operator answer — the same "gated /
  // awaiting" class as a side-effecting tool. It is NOT approved/rejected at the
  // generic gate; the loop gives it a dedicated question→answer branch (R11),
  // but classifying it side-effecting keeps it out of the auto-run read-only path.
  ask_user: 'side-effecting',
}

export const READ_ONLY_TOOLS: ToolName[] = (Object.keys(TOOL_POLICY) as ToolName[]).filter(
  (name) => TOOL_POLICY[name] === 'read-only',
)

/**
 * Model-facing descriptions. The agent declares tools to the LLM with these, so
 * the model knows what each does and when to reach for it — without them it gets
 * only the bare tool name and improvises (e.g. inventing a URL to web_fetch
 * instead of searching). Keep each one short and action-oriented.
 */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  read_file: 'Read a file from the workspace by path. Pass an optional line range like "10-40".',
  list_dir: 'List the entries of a workspace directory.',
  grep: 'Search file CONTENTS for a regular-expression pattern under a workspace path.',
  glob: 'Find files whose path matches a glob pattern (e.g. "src/**/*.ts").',
  web_search:
    'Search the web and get back real result titles, URLs, and snippets for a query. ' +
    'Use this to DISCOVER pages and current information — never guess or invent a URL. ' +
    'After searching, call web_fetch on the top 3 result URLs to compare before answering.',
  web_fetch:
    'Fetch the text of a specific URL you already have (e.g. one returned by web_search). ' +
    'This does NOT search; only pass real URLs you obtained from web_search or the task.',
  todo_write: 'Record or update your short working plan as a checklist.',
  diagnostics: 'Report compiler/linter diagnostics for a file via the language server.',
  definition: 'Jump to the definition of the symbol at a file position via the language server.',
  references: 'Find references to the symbol at a file position via the language server.',
  hover: 'Get hover info (types, docs) for the symbol at a file position via the language server.',
  write_file: 'Create or overwrite a file with the given content. Prefer edit_file for existing files.',
  edit_file: 'Replace an exact unique string in an existing file with new text.',
  multi_edit: 'Apply several exact-string replacements to one file in a single call.',
  bash:
    'Run a shell command in the workspace. Use for broad filesystem search (`find`, `grep -r`), ' +
    'running build/test commands, and anything the dedicated tools do not cover.',
  run_command: 'Run a project command (build/test/lint) with an optional timeout and capture its output.',
  task: 'Delegate a bounded sub-task to a scoped child agent with a chosen subset of tools.',
  ask_user:
    'Ask the operator ONE targeted clarifying question and WAIT for their answer before continuing. ' +
    'Use this when a needed detail is genuinely missing or ambiguous — never guess or give up. ' +
    'The run pauses until the operator replies; their answer arrives as the next message in the thread.',
}

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(toolArgSchemas, name)
}

/**
 * Classify a tool by name. Unknown tools default to 'side-effecting' — the safe
 * class that is gated behind approval and never auto-executed.
 */
export function classifyTool(name: string): ToolKind {
  return isToolName(name) ? TOOL_POLICY[name] : 'side-effecting'
}

export function isReadOnly(name: string): boolean {
  return classifyTool(name) === 'read-only'
}

export function validateToolArgs(name: ToolName, args: unknown): z.infer<(typeof toolArgSchemas)[ToolName]> {
  return toolArgSchemas[name].parse(args)
}
