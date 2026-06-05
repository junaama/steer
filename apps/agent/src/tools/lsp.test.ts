import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { classifyTool, isReadOnly } from '@steer/schema'
import type { LspClient } from '../lsp.js'
import {
  formatDiagnostics,
  formatLocations,
  makeCodeActionTool,
  makeDefinitionTool,
  makeDiagnosticsTool,
  makeFormatTool,
  makeHoverTool,
  makeReferencesTool,
  makeRenameSymbolTool,
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

describe('write-side LSP tools', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  /** A temp workspace seeded with one file; returns its ctx and absolute path. */
  async function workspace(relPath: string, content: string): Promise<{ root: string; abs: string }> {
    root = await mkdtemp(join(tmpdir(), 'steer-lsp-write-'))
    const abs = join(root, relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return { root, abs }
  }

  // A fake server: rename rewrites the file's `let n` → `let <newName>`, format
  // trims trailing whitespace, and code_action prepends a banner — each returning
  // FULL rewritten content per file (the `LspEdit` shape the helper writes).
  function writeClient(overrides: Partial<LspClient> = {}): LspClient {
    return {
      isEnabled: () => true,
      diagnostics: async () => [],
      definition: async () => [],
      references: async () => [],
      hover: async () => null,
      rename: async (path) => [{ path, newText: 'const count = 1\nexport { count }\n' }],
      format: async (path) => [{ path, newText: 'const x = 1\n' }],
      codeActions: async (path) => [{ title: 'Add missing import', edits: [{ path, newText: "import { z } from 'zod'\nconst x = 1\n" }] }],
      ...overrides,
    }
  }

  const disabledWriteClient: LspClient = {
    isEnabled: () => false,
    diagnostics: async () => [],
    definition: async () => [],
    references: async () => [],
  }

  it('classifies the write-side tools as side-effecting (gated like edits — R13/R15)', () => {
    for (const name of ['rename_symbol', 'format', 'code_action'] as const) {
      expect(classifyTool(name)).toBe('side-effecting')
      expect(isReadOnly(name)).toBe(false)
    }
  })

  it('rename_symbol applies the server edit to the file and reports the change', async () => {
    const { root: workspaceRoot, abs } = await workspace('src/index.ts', 'const n = 1\nexport { n }\n')
    const result = await makeRenameSymbolTool(writeClient())(
      { path: 'src/index.ts', line: 0, character: 6, newName: 'count' },
      { workspaceRoot },
    )
    expect(result).toBe('Renamed to count · 1 file: src/index.ts')
    expect(await readFile(abs, 'utf8')).toBe('const count = 1\nexport { count }\n')
  })

  it('rename_symbol rewrites every file in a multi-file workspace edit', async () => {
    const { root: workspaceRoot } = await workspace('a.ts', 'const n = 1\n')
    const b = join(workspaceRoot, 'b.ts')
    await writeFile(b, 'import { n } from "./a"\n', 'utf8')
    const multi = writeClient({
      rename: async () => [
        { path: join(workspaceRoot, 'a.ts'), newText: 'const count = 1\n' },
        { path: b, newText: 'import { count } from "./a"\n' },
      ],
    })
    const result = await makeRenameSymbolTool(multi)(
      { path: 'a.ts', line: 0, character: 6, newName: 'count' },
      { workspaceRoot },
    )
    expect(result).toBe('Renamed to count · 2 files: a.ts, b.ts')
    expect(await readFile(join(workspaceRoot, 'a.ts'), 'utf8')).toBe('const count = 1\n')
    expect(await readFile(b, 'utf8')).toBe('import { count } from "./a"\n')
  })

  it('rename_symbol reports clearly when the server offers no rename', async () => {
    const { root: workspaceRoot, abs } = await workspace('src/index.ts', 'const n = 1\n')
    const result = await makeRenameSymbolTool(writeClient({ rename: async () => [] }))(
      { path: 'src/index.ts', line: 0, character: 0, newName: 'count' },
      { workspaceRoot },
    )
    expect(result).toBe('No rename available for the symbol at src/index.ts:1:1.')
    expect(await readFile(abs, 'utf8')).toBe('const n = 1\n')
  })

  it('format rewrites the file with the server-formatted content', async () => {
    const { root: workspaceRoot, abs } = await workspace('src/index.ts', 'const  x=1   \n')
    const result = await makeFormatTool(writeClient())({ path: 'src/index.ts' }, { workspaceRoot })
    expect(result).toBe('Formatted src/index.ts')
    expect(await readFile(abs, 'utf8')).toBe('const x = 1\n')
  })

  it('format returns unchanged content gracefully when already formatted (no-op)', async () => {
    const { root: workspaceRoot, abs } = await workspace('src/index.ts', 'const x = 1\n')
    const result = await makeFormatTool(writeClient({ format: async () => [] }))(
      { path: 'src/index.ts' },
      { workspaceRoot },
    )
    expect(result).toBe('Already formatted · src/index.ts unchanged.')
    expect(await readFile(abs, 'utf8')).toBe('const x = 1\n')
  })

  it('code_action applies the first available action to the file', async () => {
    const { root: workspaceRoot, abs } = await workspace('src/index.ts', 'const x = 1\n')
    const result = await makeCodeActionTool(writeClient())(
      { path: 'src/index.ts', line: 0, character: 6 },
      { workspaceRoot },
    )
    expect(result).toBe('Applied "Add missing import" · src/index.ts')
    expect(await readFile(abs, 'utf8')).toBe("import { z } from 'zod'\nconst x = 1\n")
  })

  it('code_action reports clearly when no action is available', async () => {
    const { root: workspaceRoot, abs } = await workspace('src/index.ts', 'const x = 1\n')
    const result = await makeCodeActionTool(writeClient({ codeActions: async () => [] }))(
      { path: 'src/index.ts', line: 0, character: 6 },
      { workspaceRoot },
    )
    expect(result).toBe('No code action available at src/index.ts:1:7.')
    expect(await readFile(abs, 'utf8')).toBe('const x = 1\n')
  })

  it('each write-side tool degrades gracefully when the language server is unavailable', async () => {
    await expect(
      makeRenameSymbolTool(disabledWriteClient)(
        { path: 'src/index.ts', line: 0, character: 0, newName: 'count' },
        ctx,
      ),
    ).resolves.toBe('LSP is not enabled. Set STEER_LSP=1 to use this language-server action.')
    await expect(makeFormatTool(disabledWriteClient)({ path: 'src/index.ts' }, ctx)).resolves.toBe(
      'LSP is not enabled. Set STEER_LSP=1 to use this language-server action.',
    )
    await expect(
      makeCodeActionTool(disabledWriteClient)({ path: 'src/index.ts', line: 0, character: 0 }, ctx),
    ).resolves.toBe('LSP is not enabled. Set STEER_LSP=1 to use this language-server action.')
  })

  it('degrades gracefully when an enabled client lacks the optional write methods', async () => {
    const { root: workspaceRoot, abs } = await workspace('src/index.ts', 'const n = 1\n')
    const bare: LspClient = {
      isEnabled: () => true,
      diagnostics: async () => [],
      definition: async () => [],
      references: async () => [],
    }
    await expect(
      makeRenameSymbolTool(bare)({ path: 'src/index.ts', line: 0, character: 0, newName: 'count' }, { workspaceRoot }),
    ).resolves.toBe('No rename available for the symbol at src/index.ts:1:1.')
    await expect(makeFormatTool(bare)({ path: 'src/index.ts' }, { workspaceRoot })).resolves.toBe(
      'Already formatted · src/index.ts unchanged.',
    )
    await expect(
      makeCodeActionTool(bare)({ path: 'src/index.ts', line: 0, character: 0 }, { workspaceRoot }),
    ).resolves.toBe('No code action available at src/index.ts:1:1.')
    expect(await readFile(abs, 'utf8')).toBe('const n = 1\n')
  })

  it('rejects malformed args through schema validation', async () => {
    const { root: workspaceRoot } = await workspace('src/index.ts', 'const n = 1\n')
    await expect(
      makeRenameSymbolTool(writeClient())({ path: 'src/index.ts', line: 0, character: 0 }, { workspaceRoot }),
    ).rejects.toThrow()
    await expect(
      makeRenameSymbolTool(writeClient())(
        { path: 'src/index.ts', line: 0, character: 0, newName: '' },
        { workspaceRoot },
      ),
    ).rejects.toThrow()
    await expect(makeFormatTool(writeClient())({ path: '' }, { workspaceRoot })).rejects.toThrow()
    await expect(
      makeCodeActionTool(writeClient())({ path: 'src/index.ts', line: -1, character: 0 }, { workspaceRoot }),
    ).rejects.toThrow()
  })

  it('refuses paths outside the workspace root', async () => {
    const { root: workspaceRoot } = await workspace('src/index.ts', 'const n = 1\n')
    await expect(
      makeRenameSymbolTool(writeClient())(
        { path: '../outside.ts', line: 0, character: 0, newName: 'count' },
        { workspaceRoot },
      ),
    ).rejects.toThrow(/escapes/)
    await expect(makeFormatTool(writeClient())({ path: '../outside.ts' }, { workspaceRoot })).rejects.toThrow(/escapes/)
    await expect(
      makeCodeActionTool(writeClient())({ path: '../outside.ts', line: 0, character: 0 }, { workspaceRoot }),
    ).rejects.toThrow(/escapes/)
  })

  it('refuses a server-returned edit path that escapes the workspace root', async () => {
    const { root: workspaceRoot, abs } = await workspace('src/index.ts', 'const n = 1\n')
    const escaping = writeClient({ rename: async () => [{ path: '../../etc/passwd', newText: 'pwned\n' }] })
    await expect(
      makeRenameSymbolTool(escaping)(
        { path: 'src/index.ts', line: 0, character: 0, newName: 'count' },
        { workspaceRoot },
      ),
    ).rejects.toThrow(/escapes/)
    expect(await readFile(abs, 'utf8')).toBe('const n = 1\n')
  })
})
