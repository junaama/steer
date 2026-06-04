import { z } from 'zod'

const todoItemSchema = z.object({
  text: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done']),
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
  web_fetch: z.object({ url: z.string().url() }),
  todo_write: z.object({ items: z.array(todoItemSchema) }),
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
} as const

export type ToolName = keyof typeof toolArgSchemas

/** read-only tools are swap-eligible and cancellable mid-execution. */
export const TOOL_POLICY: Record<ToolName, ToolKind> = {
  read_file: 'read-only',
  list_dir: 'read-only',
  grep: 'read-only',
  glob: 'read-only',
  web_fetch: 'read-only',
  todo_write: 'read-only',
  write_file: 'side-effecting',
  edit_file: 'side-effecting',
  multi_edit: 'side-effecting',
  bash: 'side-effecting',
  run_command: 'side-effecting',
  task: 'side-effecting',
}

export const READ_ONLY_TOOLS: ToolName[] = (Object.keys(TOOL_POLICY) as ToolName[]).filter(
  (name) => TOOL_POLICY[name] === 'read-only',
)

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
