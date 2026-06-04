import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { relative, join } from 'node:path'
import { spawn } from 'node:child_process'
import { READ_ONLY_TOOLS, validateToolArgs } from '@steer/schema'
import { createLspClient } from '../lsp.js'
import { runSubagent, type SubagentDriverFactory } from '../subagent.js'
import type { AgentStore } from '../store.js'
import { edit_file, multi_edit } from './edit.js'
import { makeDefinitionTool, makeDiagnosticsTool, makeHoverTool, makeReferencesTool } from './lsp.js'
import { run_command } from './run.js'
import { safeJoin } from './paths.js'

export interface ToolContext {
  /** Where relative paths resolve and shells run — the session's working dir. */
  workspaceRoot: string
  /** Sandbox boundary file access is confined to. Defaults to workspaceRoot. */
  root?: string
  signal?: AbortSignal
  subagent?: {
    store: AgentStore
    sessionId: string
    parentToolCallId: string
    driverFor: SubagentDriverFactory
    tools: Record<string, ToolFn>
    maxSteps?: number
  }
}

export type ToolFn = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>

/** The sandbox root for a context — the broad daemon root, or the session dir. */
function sandboxRoot(ctx: ToolContext): string {
  return ctx.root ?? ctx.workspaceRoot
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

export const read_file: ToolFn = async (args, ctx) => {
  const { path } = validateToolArgs('read_file', args) as { path: string }
  return readFile(safeJoin(sandboxRoot(ctx), ctx.workspaceRoot, path), 'utf8')
}

export const list_dir: ToolFn = async (args, ctx) => {
  const { path } = validateToolArgs('list_dir', args) as { path: string }
  const entries = await readdir(safeJoin(sandboxRoot(ctx), ctx.workspaceRoot, path), { withFileTypes: true })
  return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join('\n')
}

export const grep: ToolFn = async (args, ctx) => {
  const { pattern, path } = validateToolArgs('grep', args) as { pattern: string; path: string }
  const re = new RegExp(pattern)
  const target = safeJoin(sandboxRoot(ctx), ctx.workspaceRoot, path)
  const files = (await stat(target)).isDirectory() ? await walk(target) : [target]
  const matches: string[] = []
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      if (re.test(line)) matches.push(`${relative(ctx.workspaceRoot, file)}:${i + 1}:${line}`)
    })
  }
  return matches.length > 0 ? matches.join('\n') : '— no matches'
}

export const glob: ToolFn = async (args, ctx) => {
  const { pattern } = validateToolArgs('glob', args) as { pattern: string }
  const re = new RegExp(pattern.replace(/\*/g, '.*'))
  const files = await walk(ctx.workspaceRoot)
  const rel = files.map((f) => relative(ctx.workspaceRoot, f)).filter((f) => re.test(f))
  return rel.length > 0 ? rel.sort().join('\n') : '— no files'
}

export const web_fetch: ToolFn = async (args, ctx) => {
  const { url } = validateToolArgs('web_fetch', args) as { url: string }
  const res = await fetch(url, { signal: ctx.signal })
  return (await res.text()).slice(0, 4000)
}

/** Decode a DuckDuckGo HTML result href to its real target URL. */
function ddgResultUrl(href: string): string {
  const redirect = /[?&]uddg=([^&]+)/.exec(href)
  if (redirect) return decodeURIComponent(redirect[1]!)
  return href.startsWith('//') ? `https:${href}` : href
}

/** Strip tags and decode the handful of HTML entities DuckDuckGo emits. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Real web search via DuckDuckGo's keyless HTML endpoint. The agent uses this to
 * DISCOVER real URLs instead of inventing a plausible domain and web_fetching it
 * (the failure this tool exists to fix). Returns ranked title / url / snippet
 * triples for the model to then web_fetch.
 */
export const web_search: ToolFn = async (args, ctx) => {
  const { query } = validateToolArgs('web_search', args) as { query: string }
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    signal: ctx.signal,
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; steer-agent/0.0)' },
  })
  const html = await res.text()
  const snippets: string[] = []
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) snippets.push(stripHtml(m[1]!))
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const results: string[] = []
  for (let m = linkRe.exec(html); m && results.length < 8; m = linkRe.exec(html)) {
    const url = ddgResultUrl(m[1]!)
    const title = stripHtml(m[2]!)
    const snippet = snippets[results.length] ?? ''
    results.push(`${results.length + 1}. ${title}\n   ${url}${snippet ? `\n   ${snippet}` : ''}`)
  }
  return results.length > 0 ? results.join('\n\n') : `— no results for "${query}"`
}

export const todo_write: ToolFn = async (args) => {
  const { items } = validateToolArgs('todo_write', args) as {
    items: { text: string; status: 'pending' | 'in_progress' | 'done' }[]
  }
  return `Updated plan · ${items.length} items`
}

export const task: ToolFn = async (args, ctx) => {
  const { description, prompt, tools: requestedTools } = validateToolArgs('task', args) as {
    description: string
    prompt: string
    tools?: string[]
  }
  const subagent = ctx.subagent
  if (!subagent) return 'error: task subagent runner is unavailable'

  const allowedTools = (requestedTools ?? READ_ONLY_TOOLS).filter((name) =>
    Object.prototype.hasOwnProperty.call(subagent.tools, name),
  )
  const driver = subagent.driverFor({ description, prompt, tools: allowedTools })
  return runSubagent(
    {
      store: subagent.store,
      sessionId: subagent.sessionId,
      parentToolCallId: subagent.parentToolCallId,
      driver,
      tools: subagent.tools,
      workspaceRoot: ctx.workspaceRoot,
      root: ctx.root,
      signal: ctx.signal,
      maxSteps: subagent.maxSteps,
    },
    { description, prompt, allowedTools },
  )
}

export const write_file: ToolFn = async (args, ctx) => {
  const { path, content } = validateToolArgs('write_file', args) as { path: string; content: string }
  await writeFile(safeJoin(sandboxRoot(ctx), ctx.workspaceRoot, path), content, 'utf8')
  return `Wrote ${path} · ${content.split('\n').length} lines`
}

export const bash: ToolFn = (args, ctx) =>
  new Promise<string>((resolvePromise, reject) => {
    const { command } = validateToolArgs('bash', args) as { command: string }
    const child = spawn('sh', ['-c', command], { cwd: ctx.workspaceRoot, signal: ctx.signal })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err) => reject(err))
    child.on('close', (code) => resolvePromise(out + (code === 0 ? '' : `\n[exit ${code}]`)))
  })

const lsp = createLspClient()

export const tools: Record<string, ToolFn> = {
  read_file,
  list_dir,
  grep,
  glob,
  web_search,
  web_fetch,
  todo_write,
  diagnostics: makeDiagnosticsTool(lsp),
  definition: makeDefinitionTool(lsp),
  references: makeReferencesTool(lsp),
  hover: makeHoverTool(lsp),
  write_file,
  edit_file,
  multi_edit,
  bash,
  run_command,
  task,
}

export { edit_file, multi_edit, run_command }
