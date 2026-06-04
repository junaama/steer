import { describe, it, expect } from 'vitest'
import {
  classifyTool,
  isReadOnly,
  isToolName,
  validateToolArgs,
  READ_ONLY_TOOLS,
  TOOL_POLICY,
  TOOL_DESCRIPTIONS,
} from './tools.js'

describe('tool policy', () => {
  it('classifies every read-only tool as read-only', () => {
    for (const name of [
      'read_file',
      'list_dir',
      'grep',
      'glob',
      'web_search',
      'web_fetch',
      'todo_write',
      'diagnostics',
      'definition',
      'references',
      'hover',
    ] as const) {
      expect(classifyTool(name)).toBe('read-only')
      expect(isReadOnly(name)).toBe(true)
    }
  })

  it('classifies side-effecting tools as side-effecting', () => {
    for (const name of ['write_file', 'edit_file', 'multi_edit', 'bash', 'run_command', 'task'] as const) {
      expect(classifyTool(name)).toBe('side-effecting')
      expect(isReadOnly(name)).toBe(false)
    }
  })

  it('defaults unknown tools to side-effecting (the safe, gated class)', () => {
    expect(classifyTool('rm_rf_everything')).toBe('side-effecting')
    expect(isReadOnly('totally_unknown')).toBe(false)
  })

  it('READ_ONLY_TOOLS contains exactly the read-only tools', () => {
    expect([...READ_ONLY_TOOLS].sort()).toEqual(
      ['definition', 'diagnostics', 'glob', 'grep', 'hover', 'list_dir', 'read_file', 'references', 'todo_write', 'web_search', 'web_fetch'].sort(),
    )
    expect(READ_ONLY_TOOLS).not.toContain('write_file')
    expect(READ_ONLY_TOOLS).not.toContain('edit_file')
    expect(READ_ONLY_TOOLS).not.toContain('multi_edit')
    expect(READ_ONLY_TOOLS).not.toContain('bash')
    expect(READ_ONLY_TOOLS).not.toContain('run_command')
    expect(READ_ONLY_TOOLS).not.toContain('task')
  })

  it('isToolName narrows known names', () => {
    expect(isToolName('grep')).toBe(true)
    expect(isToolName('nope')).toBe(false)
  })

  it('every tool in TOOL_POLICY has an arg schema', () => {
    for (const name of Object.keys(TOOL_POLICY)) {
      expect(isToolName(name)).toBe(true)
    }
  })

  it('every tool has a non-empty model-facing description', () => {
    for (const name of Object.keys(TOOL_POLICY) as (keyof typeof TOOL_POLICY)[]) {
      expect(TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(0)
      // The description must say more than the bare tool name — that emptiness is
      // exactly what made the agent improvise instead of using the right tool.
      expect(TOOL_DESCRIPTIONS[name]).not.toBe(name)
    }
    // web_search must steer the model away from inventing URLs.
    expect(TOOL_DESCRIPTIONS.web_search).toMatch(/never guess|invent/i)
  })
})

describe('validateToolArgs', () => {
  it('accepts valid args', () => {
    expect(validateToolArgs('grep', { pattern: 'login', path: 'src/' })).toEqual({
      pattern: 'login',
      path: 'src/',
    })
    expect(validateToolArgs('web_search', { query: 'agentic commerce 2026' })).toEqual({
      query: 'agentic commerce 2026',
    })
    expect(validateToolArgs('web_fetch', { url: 'https://example.com' })).toEqual({
      url: 'https://example.com',
    })
    expect(validateToolArgs('edit_file', { path: 'src/a.ts', old_string: 'old', new_string: 'new' })).toEqual({
      path: 'src/a.ts',
      old_string: 'old',
      new_string: 'new',
    })
    expect(
      validateToolArgs('multi_edit', {
        path: 'src/a.ts',
        edits: [
          { old_string: 'old', new_string: 'new' },
          { old_string: 'new', new_string: 'newer' },
        ],
      }),
    ).toEqual({
      path: 'src/a.ts',
      edits: [
        { old_string: 'old', new_string: 'new' },
        { old_string: 'new', new_string: 'newer' },
      ],
    })
    expect(validateToolArgs('run_command', { command: 'pnpm test', timeoutMs: 1000 })).toEqual({
      command: 'pnpm test',
      timeoutMs: 1000,
    })
    expect(validateToolArgs('run_command', { command: 'pnpm test' })).toEqual({ command: 'pnpm test' })
    expect(validateToolArgs('diagnostics', { path: 'src/index.ts' })).toEqual({ path: 'src/index.ts' })
    expect(validateToolArgs('definition', { path: 'src/index.ts', line: 4, character: 10 })).toEqual({
      path: 'src/index.ts',
      line: 4,
      character: 10,
    })
    expect(validateToolArgs('references', { path: 'src/index.ts', line: 4, character: 10 })).toEqual({
      path: 'src/index.ts',
      line: 4,
      character: 10,
    })
    expect(validateToolArgs('hover', { path: 'src/index.ts', line: 4, character: 10 })).toEqual({
      path: 'src/index.ts',
      line: 4,
      character: 10,
    })
    expect(validateToolArgs('task', { description: 'Inspect', prompt: 'Read src/index.ts' })).toEqual({
      description: 'Inspect',
      prompt: 'Read src/index.ts',
    })
    expect(
      validateToolArgs('task', { description: 'Inspect', prompt: 'Read src/index.ts', tools: ['read_file'] }),
    ).toEqual({
      description: 'Inspect',
      prompt: 'Read src/index.ts',
      tools: ['read_file'],
    })
    expect(
      validateToolArgs('todo_write', {
        items: [
          { text: 'write tests', status: 'pending' },
          { text: 'implement tool', status: 'in_progress' },
          { text: 'verify coverage', status: 'done' },
        ],
      }),
    ).toEqual({
      items: [
        { text: 'write tests', status: 'pending' },
        { text: 'implement tool', status: 'in_progress' },
        { text: 'verify coverage', status: 'done' },
      ],
    })
  })

  it('rejects malformed args', () => {
    expect(() => validateToolArgs('grep', { pattern: '' })).toThrow()
    expect(() => validateToolArgs('web_search', { query: '' })).toThrow()
    expect(() => validateToolArgs('web_fetch', { url: 'not-a-url' })).toThrow()
    expect(() => validateToolArgs('write_file', { path: 'x' })).toThrow() // missing content
    expect(() => validateToolArgs('edit_file', { path: 'x', old_string: 'old' })).toThrow()
    expect(() => validateToolArgs('multi_edit', { path: 'x', edits: [{ old_string: 'old' }] })).toThrow()
    expect(() => validateToolArgs('run_command', { command: '' })).toThrow()
    expect(() => validateToolArgs('run_command', { command: 'pnpm test', timeoutMs: 0 })).toThrow()
    expect(() => validateToolArgs('run_command', { command: 'pnpm test', timeoutMs: 1.5 })).toThrow()
    expect(() => validateToolArgs('diagnostics', { path: '' })).toThrow()
    expect(() => validateToolArgs('definition', { path: 'src/index.ts', line: -1, character: 10 })).toThrow()
    expect(() => validateToolArgs('definition', { path: 'src/index.ts', line: 1 })).toThrow()
    expect(() => validateToolArgs('references', { path: 'src/index.ts', line: 1.5, character: 10 })).toThrow()
    expect(() => validateToolArgs('references', { path: 'src/index.ts', line: 1, character: -1 })).toThrow()
    expect(() => validateToolArgs('hover', { path: 'src/index.ts', line: 1, character: 1.5 })).toThrow()
    expect(() => validateToolArgs('task', { description: '', prompt: 'Read' })).toThrow()
    expect(() => validateToolArgs('task', { description: 'Inspect', prompt: '' })).toThrow()
    expect(() => validateToolArgs('task', { description: 'Inspect', prompt: 'Read', tools: [''] })).toThrow()
    expect(() => validateToolArgs('todo_write', { items: [{ text: 'x', status: 'blocked' }] })).toThrow()
    expect(() => validateToolArgs('todo_write', { items: [{ status: 'pending' }] })).toThrow()
  })
})
