import { writeFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { validateToolArgs } from '@steer/schema'
import type { LspClient, LspDiagnostic, LspEdit, LspLocation } from '../lsp.js'
import type { ToolContext, ToolFn } from './index.js'
import { safeJoin } from './paths.js'

const LSP_DISABLED_MESSAGE = 'LSP is not enabled. Set STEER_LSP=1 to use this read-only tool.'
// Write-side tools are gated, but when no server is running they must degrade
// gracefully (no throw) — mirror the read-only message with the action's verb.
const LSP_WRITE_DISABLED_MESSAGE = 'LSP is not enabled. Set STEER_LSP=1 to use this language-server action.'

interface PositionArgs {
  path: string
  line: number
  character: number
}

export function formatDiagnostics(diagnostics: readonly LspDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No diagnostics.'
  return diagnostics
    .map((diagnostic) => {
      const line = diagnostic.range.start.line + 1
      const column = diagnostic.range.start.character + 1
      return `${diagnostic.path}:${line}:${column} ${diagnostic.severity} ${diagnostic.message}`
    })
    .join('\n')
}

export function formatLocations(locations: readonly LspLocation[]): string {
  if (locations.length === 0) return 'No locations.'
  return locations.map((location) => `${location.path}:${location.range.start.line + 1}`).join('\n')
}

function unavailable(client: LspClient): string | null {
  return client.isEnabled() ? null : LSP_DISABLED_MESSAGE
}

export function makeDiagnosticsTool(client: LspClient): ToolFn {
  return async (args, ctx) => {
    const disabled = unavailable(client)
    if (disabled !== null) return disabled
    const { path } = validateToolArgs('diagnostics', args) as { path: string }
    return formatDiagnostics(await client.diagnostics(safeJoin(ctx.root ?? ctx.workspaceRoot, ctx.workspaceRoot, path)))
  }
}

export function makeDefinitionTool(client: LspClient): ToolFn {
  return async (args, ctx) => {
    const disabled = unavailable(client)
    if (disabled !== null) return disabled
    const { path, line, character } = validateToolArgs('definition', args) as PositionArgs
    return formatLocations(await client.definition(safeJoin(ctx.root ?? ctx.workspaceRoot, ctx.workspaceRoot, path), line, character))
  }
}

export function makeReferencesTool(client: LspClient): ToolFn {
  return async (args, ctx) => {
    const disabled = unavailable(client)
    if (disabled !== null) return disabled
    const { path, line, character } = validateToolArgs('references', args) as PositionArgs
    return formatLocations(await client.references(safeJoin(ctx.root ?? ctx.workspaceRoot, ctx.workspaceRoot, path), line, character))
  }
}

export function makeHoverTool(client: LspClient): ToolFn {
  return async (args, ctx) => {
    const disabled = unavailable(client)
    if (disabled !== null) return disabled
    const { path, line, character } = validateToolArgs('hover', args) as PositionArgs
    const text = (await client.hover?.(safeJoin(ctx.root ?? ctx.workspaceRoot, ctx.workspaceRoot, path), line, character)) ?? null
    return text ?? 'No hover information.'
  }
}

/** Reasons a write-side LSP tool cannot run, surfaced as a plain message (no throw). */
function writeUnavailable(client: LspClient): string | null {
  return client.isEnabled() ? null : LSP_WRITE_DISABLED_MESSAGE
}

/**
 * Write the server-computed edits to disk, each confined to the workspace guard,
 * and report which files changed. Edits arrive as full rewritten file contents
 * (see `LspEdit`); we resolve each path through `safeJoin` so a server-returned
 * path outside the root is refused before any write.
 */
async function applyLspEdits(edits: readonly LspEdit[], ctx: ToolContext): Promise<string[]> {
  const sandbox = ctx.root ?? ctx.workspaceRoot
  const changed: string[] = []
  for (const edit of edits) {
    const fullPath = safeJoin(sandbox, ctx.workspaceRoot, edit.path)
    await writeFile(fullPath, edit.newText, 'utf8')
    changed.push(relative(ctx.workspaceRoot, fullPath))
  }
  return changed
}

export function makeRenameSymbolTool(client: LspClient): ToolFn {
  return async (args, ctx) => {
    const disabled = writeUnavailable(client)
    if (disabled !== null) return disabled
    const { path, line, character, newName } = validateToolArgs('rename_symbol', args) as PositionArgs & {
      newName: string
    }
    const fullPath = safeJoin(ctx.root ?? ctx.workspaceRoot, ctx.workspaceRoot, path)
    const edits = (await client.rename?.(fullPath, line, character, newName)) ?? []
    if (edits.length === 0) return `No rename available for the symbol at ${path}:${line + 1}:${character + 1}.`
    const changed = await applyLspEdits(edits, ctx)
    return `Renamed to ${newName} · ${changed.length} file${changed.length === 1 ? '' : 's'}: ${changed.join(', ')}`
  }
}

export function makeFormatTool(client: LspClient): ToolFn {
  return async (args, ctx) => {
    const disabled = writeUnavailable(client)
    if (disabled !== null) return disabled
    const { path } = validateToolArgs('format', args) as { path: string }
    const fullPath = safeJoin(ctx.root ?? ctx.workspaceRoot, ctx.workspaceRoot, path)
    const edits = (await client.format?.(fullPath)) ?? []
    if (edits.length === 0) return `Already formatted · ${path} unchanged.`
    const changed = await applyLspEdits(edits, ctx)
    return `Formatted ${changed.join(', ')}`
  }
}

export function makeCodeActionTool(client: LspClient): ToolFn {
  return async (args, ctx) => {
    const disabled = writeUnavailable(client)
    if (disabled !== null) return disabled
    const { path, line, character } = validateToolArgs('code_action', args) as PositionArgs
    const fullPath = safeJoin(ctx.root ?? ctx.workspaceRoot, ctx.workspaceRoot, path)
    const actions = (await client.codeActions?.(fullPath, line, character)) ?? []
    const action = actions[0]
    if (!action) return `No code action available at ${path}:${line + 1}:${character + 1}.`
    const changed = await applyLspEdits(action.edits, ctx)
    return `Applied "${action.title}" · ${changed.join(', ')}`
  }
}
