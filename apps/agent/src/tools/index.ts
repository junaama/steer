import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join } from 'node:path'
import { spawn } from 'node:child_process'
import { validateToolArgs } from '@steer/schema'
import { edit_file, multi_edit } from './edit.js'

export interface ToolContext {
  workspaceRoot: string
  signal?: AbortSignal
}

export type ToolFn = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>

/** Resolve a path inside the workspace, refusing traversal outside it. */
function safeJoin(root: string, path: string): string {
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${path}`)
  return full
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
  return readFile(safeJoin(ctx.workspaceRoot, path), 'utf8')
}

export const list_dir: ToolFn = async (args, ctx) => {
  const { path } = validateToolArgs('list_dir', args) as { path: string }
  const entries = await readdir(safeJoin(ctx.workspaceRoot, path), { withFileTypes: true })
  return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join('\n')
}

export const grep: ToolFn = async (args, ctx) => {
  const { pattern, path } = validateToolArgs('grep', args) as { pattern: string; path: string }
  const re = new RegExp(pattern)
  const target = safeJoin(ctx.workspaceRoot, path)
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

export const write_file: ToolFn = async (args, ctx) => {
  const { path, content } = validateToolArgs('write_file', args) as { path: string; content: string }
  await writeFile(safeJoin(ctx.workspaceRoot, path), content, 'utf8')
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

export const tools: Record<string, ToolFn> = {
  read_file,
  list_dir,
  grep,
  glob,
  web_fetch,
  write_file,
  edit_file,
  multi_edit,
  bash,
}

export { edit_file, multi_edit }
