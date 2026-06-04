import { describe, expect, it } from 'vitest'
import type { LspClient } from '../lsp.js'
import {
  formatDiagnostics,
  formatLocations,
  makeDefinitionTool,
  makeDiagnosticsTool,
  makeHoverTool,
  makeReferencesTool,
} from './lsp.js'

const enabledClient: LspClient = {
  isEnabled: () => true,
  diagnostics: async (path) => [
    {
      path,
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
      severity: 'error',
      message: 'Type mismatch',
    },
  ],
  definition: async (path, line, character) => [
    {
      path,
      range: { start: { line, character }, end: { line, character: character + 4 } },
    },
  ],
  references: async (path, line, character) => [
    {
      path,
      range: { start: { line, character }, end: { line, character: character + 4 } },
    },
    {
      path: 'src/other.ts',
      range: { start: { line: 9, character: 1 }, end: { line: 9, character: 5 } },
    },
  ],
  hover: async () => 'const answer: number',
}

const emptyClient: LspClient = {
  isEnabled: () => true,
  diagnostics: async () => [],
  definition: async () => [],
  references: async () => [],
  hover: async () => null,
}

const disabledClient: LspClient = {
  isEnabled: () => false,
  diagnostics: async () => [],
  definition: async () => [],
  references: async () => [],
}

const ctx = { workspaceRoot: '/repo' }

describe('formatDiagnostics', () => {
  it('renders path, one-based line and column, severity, and message', () => {
    expect(
      formatDiagnostics([
        {
          path: 'src/index.ts',
          range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
          severity: 'warning',
          message: 'Possibly undefined',
        },
      ]),
    ).toBe('src/index.ts:1:5 warning Possibly undefined')
  })

  it('reports an empty diagnostics result clearly', () => {
    expect(formatDiagnostics([])).toBe('No diagnostics.')
  })
})

describe('formatLocations', () => {
  it('renders path and one-based line for one or more locations', () => {
    expect(
      formatLocations([
        { path: 'src/a.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } } },
        { path: 'src/b.ts', range: { start: { line: 4, character: 3 }, end: { line: 4, character: 8 } } },
      ]),
    ).toBe('src/a.ts:3\nsrc/b.ts:5')
  })

  it('reports an empty location result clearly', () => {
    expect(formatLocations([])).toBe('No locations.')
  })
})

describe('LSP tool factories', () => {
  it('formats diagnostics returned by an injected client', async () => {
    await expect(makeDiagnosticsTool(enabledClient)({ path: 'src/index.ts' }, ctx)).resolves.toBe(
      '/repo/src/index.ts:2:3 error Type mismatch',
    )
  })

  it('formats definitions returned by an injected client', async () => {
    await expect(
      makeDefinitionTool(enabledClient)({ path: 'src/index.ts', line: 4, character: 8 }, ctx),
    ).resolves.toBe('/repo/src/index.ts:5')
  })

  it('formats references returned by an injected client', async () => {
    await expect(
      makeReferencesTool(enabledClient)({ path: 'src/index.ts', line: 4, character: 8 }, ctx),
    ).resolves.toBe('/repo/src/index.ts:5\nsrc/other.ts:10')
  })

  it('formats hover text returned by an injected client', async () => {
    await expect(makeHoverTool(enabledClient)({ path: 'src/index.ts', line: 4, character: 8 }, ctx)).resolves.toBe(
      'const answer: number',
    )
  })

  it('returns clear empty messages for enabled clients with no results', async () => {
    await expect(makeDiagnosticsTool(emptyClient)({ path: 'src/index.ts' }, ctx)).resolves.toBe('No diagnostics.')
    await expect(makeDefinitionTool(emptyClient)({ path: 'src/index.ts', line: 0, character: 0 }, ctx)).resolves.toBe(
      'No locations.',
    )
    await expect(makeReferencesTool(emptyClient)({ path: 'src/index.ts', line: 0, character: 0 }, ctx)).resolves.toBe(
      'No locations.',
    )
    await expect(makeHoverTool(emptyClient)({ path: 'src/index.ts', line: 0, character: 0 }, ctx)).resolves.toBe(
      'No hover information.',
    )
  })

  it('returns a read-only disabled message when LSP is unavailable', async () => {
    await expect(makeDiagnosticsTool(disabledClient)({ path: 'src/index.ts' }, ctx)).resolves.toBe(
      'LSP is not enabled. Set STEER_LSP=1 to use this read-only tool.',
    )
    await expect(
      makeDefinitionTool(disabledClient)({ path: 'src/index.ts', line: 0, character: 0 }, ctx),
    ).resolves.toBe('LSP is not enabled. Set STEER_LSP=1 to use this read-only tool.')
  })

  it('rejects malformed args through schema validation', async () => {
    await expect(makeDefinitionTool(enabledClient)({ path: 'src/index.ts', line: -1, character: 0 }, ctx)).rejects.toThrow()
    await expect(makeReferencesTool(enabledClient)({ path: 'src/index.ts', line: 1 }, ctx)).rejects.toThrow()
    await expect(makeDiagnosticsTool(enabledClient)({ path: '' }, ctx)).rejects.toThrow()
  })

  it('refuses paths outside the workspace', async () => {
    await expect(makeDiagnosticsTool(enabledClient)({ path: '../outside.ts' }, ctx)).rejects.toThrow(/escapes/)
  })
})
