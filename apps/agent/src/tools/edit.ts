import { readFile, writeFile } from 'node:fs/promises'
import { validateToolArgs } from '@steer/schema'
import type { ToolFn } from './index.js'
import { safeJoin } from './paths.js'

export interface Edit {
  old_string: string
  new_string: string
}

function countMatches(content: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const index = content.indexOf(needle, from)
    if (index === -1) return count
    count += 1
    from = index + needle.length
  }
}

function lineDelta(before: string, after: string): string {
  const delta = after.split('\n').length - before.split('\n').length
  if (delta > 0) return `+${delta}`
  if (delta < 0) return String(delta)
  return '±0'
}

function applyEdit(content: string, edit: Edit): string {
  const matches = countMatches(content, edit.old_string)
  if (matches === 0) throw new Error('old_string not found')
  if (matches > 1) throw new Error(`old_string is ambiguous, appears ${matches} times`)
  return content.replace(edit.old_string, edit.new_string)
}

export function applyEdits(content: string, edits: readonly Edit[]): string {
  return edits.reduce((next, edit, index) => {
    try {
      return applyEdit(next, edit)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`edit ${index + 1}: ${message}`)
    }
  }, content)
}

export const edit_file: ToolFn = async (args, ctx) => {
  const { path, old_string, new_string } = validateToolArgs('edit_file', args) as {
    path: string
    old_string: string
    new_string: string
  }
  const fullPath = safeJoin(ctx.root ?? ctx.workspaceRoot, ctx.workspaceRoot, path, ctx.homeDir)
  const before = await readFile(fullPath, 'utf8')
  const after = applyEdits(before, [{ old_string, new_string }])
  await writeFile(fullPath, after, 'utf8')
  return `Edited ${path} · ${lineDelta(before, after)} lines`
}

export const multi_edit: ToolFn = async (args, ctx) => {
  const { path, edits } = validateToolArgs('multi_edit', args) as { path: string; edits: Edit[] }
  const fullPath = safeJoin(ctx.root ?? ctx.workspaceRoot, ctx.workspaceRoot, path, ctx.homeDir)
  const before = await readFile(fullPath, 'utf8')
  const after = applyEdits(before, edits)
  await writeFile(fullPath, after, 'utf8')
  return `Edited ${path} · ${lineDelta(before, after)} lines`
}
