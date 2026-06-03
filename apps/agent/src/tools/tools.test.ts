import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { read_file, list_dir, grep, glob, web_fetch, write_file, bash, edit_file, multi_edit } from './index.js'
import { applyEdits } from './edit.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'steer-tools-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'login.ts'), 'export function login() {\n  return null // bug\n}\n')
  await writeFile(join(root, 'README.md'), '# demo\n')
})

const ctx = () => ({ workspaceRoot: root })

describe('read_file', () => {
  it('reads a file', async () => {
    expect(await read_file({ path: 'src/login.ts' }, ctx())).toContain('return null')
  })
  it('throws on a missing file', async () => {
    await expect(read_file({ path: 'nope.ts' }, ctx())).rejects.toThrow()
  })
  it('refuses path traversal outside the workspace', async () => {
    await expect(read_file({ path: '../../etc/passwd' }, ctx())).rejects.toThrow(/escapes/)
  })
})

describe('list_dir', () => {
  it('lists entries with a trailing slash on directories', async () => {
    const out = await list_dir({ path: '.' }, ctx())
    expect(out.split('\n')).toEqual(['README.md', 'src/'])
  })
})

describe('grep', () => {
  it('returns file:line:text matches', async () => {
    const out = await grep({ pattern: 'return null', path: 'src' }, ctx())
    expect(out).toContain('src/login.ts:2:')
    expect(out).toContain('return null')
  })
  it('reports no matches', async () => {
    expect(await grep({ pattern: 'zzz_nomatch', path: 'src' }, ctx())).toBe('— no matches')
  })
})

describe('write_file', () => {
  it('writes content and confirms', async () => {
    const res = await write_file({ path: 'out.txt', content: 'a\nb' }, ctx())
    expect(res).toContain('Wrote out.txt')
    expect(await read_file({ path: 'out.txt' }, ctx())).toBe('a\nb')
  })
})

describe('applyEdits', () => {
  it('applies ordered edits and returns new content', () => {
    expect(
      applyEdits('alpha\nbeta\ngamma\n', [
        { old_string: 'beta', new_string: 'delta' },
        { old_string: 'delta', new_string: 'epsilon' },
      ]),
    ).toBe('alpha\nepsilon\ngamma\n')
  })

  it('returns unchanged content for an empty edit list', () => {
    expect(applyEdits('same', [])).toBe('same')
  })

  it('throws when an edit string is absent', () => {
    expect(() => applyEdits('abc', [{ old_string: 'missing', new_string: 'x' }])).toThrow(/not found/)
  })

  it('throws when an edit string is ambiguous', () => {
    expect(() => applyEdits('dup dup', [{ old_string: 'dup', new_string: 'x' }])).toThrow(
      /ambiguous, appears 2 times/,
    )
  })
})

describe('edit_file', () => {
  it('replaces a unique string and confirms changed line count', async () => {
    await writeFile(join(root, 'edit-lines.txt'), 'one\ntwo\nthree\n')
    const res = await edit_file(
      { path: 'edit-lines.txt', old_string: 'two', new_string: 'two\ninserted' },
      ctx(),
    )
    expect(res).toBe('Edited edit-lines.txt · +1 lines')
    expect(await readFile(join(root, 'edit-lines.txt'), 'utf8')).toBe('one\ntwo\ninserted\nthree\n')
  })

  it('does not write when the old string is absent', async () => {
    await writeFile(join(root, 'edit-missing.txt'), 'stable')
    await expect(
      edit_file({ path: 'edit-missing.txt', old_string: 'missing', new_string: 'changed' }, ctx()),
    ).rejects.toThrow(/not found/)
    expect(await readFile(join(root, 'edit-missing.txt'), 'utf8')).toBe('stable')
  })

  it('does not write when the old string appears more than once', async () => {
    await writeFile(join(root, 'edit-ambiguous.txt'), 'same same')
    await expect(
      edit_file({ path: 'edit-ambiguous.txt', old_string: 'same', new_string: 'changed' }, ctx()),
    ).rejects.toThrow(/ambiguous, appears 2 times/)
    expect(await readFile(join(root, 'edit-ambiguous.txt'), 'utf8')).toBe('same same')
  })

  it('refuses path traversal outside the workspace', async () => {
    await expect(edit_file({ path: '../outside.txt', old_string: 'x', new_string: 'y' }, ctx())).rejects.toThrow(
      /escapes/,
    )
  })
})

describe('multi_edit', () => {
  it('applies three sequential edits and writes once', async () => {
    await writeFile(join(root, 'multi.txt'), 'red\ngreen\nblue\n')
    const res = await multi_edit(
      {
        path: 'multi.txt',
        edits: [
          { old_string: 'red', new_string: 'cyan' },
          { old_string: 'green', new_string: 'magenta' },
          { old_string: 'blue', new_string: 'yellow' },
        ],
      },
      ctx(),
    )
    expect(res).toBe('Edited multi.txt · ±0 lines')
    expect(await readFile(join(root, 'multi.txt'), 'utf8')).toBe('cyan\nmagenta\nyellow\n')
  })

  it('uses ordered semantics where later edits can match earlier replacements', async () => {
    await writeFile(join(root, 'multi-ordered.txt'), 'start')
    await multi_edit(
      {
        path: 'multi-ordered.txt',
        edits: [
          { old_string: 'start', new_string: 'middle' },
          { old_string: 'middle', new_string: 'end' },
        ],
      },
      ctx(),
    )
    expect(await readFile(join(root, 'multi-ordered.txt'), 'utf8')).toBe('end')
  })

  it('aborts without writing when a later edit fails', async () => {
    await writeFile(join(root, 'multi-fail.txt'), 'first second')
    await expect(
      multi_edit(
        {
          path: 'multi-fail.txt',
          edits: [
            { old_string: 'first', new_string: 'changed' },
            { old_string: 'missing', new_string: 'nope' },
          ],
        },
        ctx(),
      ),
    ).rejects.toThrow(/edit 2: old_string not found/)
    expect(await readFile(join(root, 'multi-fail.txt'), 'utf8')).toBe('first second')
  })

  it('returns unchanged confirmation for an empty edits array', async () => {
    await writeFile(join(root, 'multi-empty.txt'), 'unchanged')
    await expect(multi_edit({ path: 'multi-empty.txt', edits: [] }, ctx())).resolves.toBe(
      'Edited multi-empty.txt · ±0 lines',
    )
    expect(await readFile(join(root, 'multi-empty.txt'), 'utf8')).toBe('unchanged')
  })
})

describe('glob', () => {
  it('matches files by glob pattern', async () => {
    expect(await glob({ pattern: '*.md' }, ctx())).toContain('README.md')
  })
  it('reports no files', async () => {
    expect(await glob({ pattern: '*.nope' }, ctx())).toBe('— no files')
  })
})

describe('web_fetch', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('fetches text from a url', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello body')))
    expect(await web_fetch({ url: 'http://example.test' }, ctx())).toBe('hello body')
  })
})

describe('bash', () => {
  it('runs a command and captures stdout', async () => {
    expect((await bash({ command: 'echo hi' }, ctx())).trim()).toBe('hi')
  })
  it('appends a non-zero exit marker', async () => {
    expect(await bash({ command: 'exit 3' }, ctx())).toContain('[exit 3]')
  })
})
