import { validateToolArgs } from '@steer/schema'
import type { LspClient, LspDiagnostic, LspLocation } from '../lsp.js'
import type { ToolFn } from './index.js'
import { safeJoin } from './paths.js'

const LSP_DISABLED_MESSAGE = 'LSP is not enabled. Set STEER_LSP=1 to use this read-only tool.'

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
