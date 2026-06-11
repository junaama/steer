import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  read_file,
  list_dir,
  grep,
  glob,
  web_search,
  web_fetch,
  write_file,
  todo_write,
  task,
  ask_user,
  bash,
  edit_file,
  multi_edit,
  run_command,
} from './index.js'
import { applyEdits } from './edit.js'
import { runShellCommand } from './run.js'
import { TOOL_DESCRIPTIONS } from '@steer/schema'

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

describe('sandbox split: session workdir within a broader daemon root', () => {
  let base: string
  let projectA: string
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'steer-split-'))
    projectA = join(base, 'projectA')
    await mkdir(projectA)
    await mkdir(join(base, 'projectB'))
    await writeFile(join(projectA, 'a.txt'), 'in A')
    await writeFile(join(base, 'projectB', 'b.txt'), 'in B')
  })
  // root = the broad daemon root; workspaceRoot = the session's cwd within it.
  const split = () => ({ workspaceRoot: projectA, root: base })

  it('resolves relative paths against the session workdir, not the root', async () => {
    expect(await read_file({ path: 'a.txt' }, split())).toBe('in A')
    expect((await list_dir({ path: '.' }, split())).split('\n')).toEqual(['a.txt'])
  })

  it('reaches a sibling directory under the root (request broader scope)', async () => {
    expect(await read_file({ path: '../projectB/b.txt' }, split())).toBe('in B')
  })

  it('still refuses a path above the root', async () => {
    await expect(read_file({ path: '/etc/passwd' }, split())).rejects.toThrow(/escapes/)
  })

  it('confines writes to the root: a sibling is allowed, above the root is not', async () => {
    await write_file({ path: '../projectB/new.txt', content: 'hi' }, split())
    expect(await readFile(join(base, 'projectB', 'new.txt'), 'utf8')).toBe('hi')
    await expect(write_file({ path: '/etc/x', content: 'no' }, split())).rejects.toThrow(/escapes/)
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

describe('todo_write', () => {
  it('validates todo items and confirms the updated plan count', async () => {
    await expect(
      todo_write(
        {
          items: [
            { text: 'write tests', status: 'pending' },
            { text: 'implement tool', status: 'in_progress' },
            { text: 'verify coverage', status: 'done' },
          ],
        },
        ctx(),
      ),
    ).resolves.toBe('Updated plan · 3 items')
  })

  it('rejects malformed todo items', async () => {
    await expect(todo_write({ items: [{ text: 'write tests', status: 'blocked' }] }, ctx())).rejects.toThrow()
  })
})

describe('task', () => {
  it('returns an error when no subagent runner is available', async () => {
    await expect(task({ description: 'Inspect', prompt: 'Read src/login.ts' }, ctx())).resolves.toBe(
      'error: task subagent runner is unavailable',
    )
  })
})

describe('ask_user', () => {
  it('validates the question and echoes it (fallback path; the loop owns the wait)', async () => {
    await expect(ask_user({ question: 'Which folder?' }, ctx())).resolves.toBe('Asked the operator: Which folder?')
  })

  it('rejects a missing or empty question', async () => {
    await expect(ask_user({ question: '' }, ctx())).rejects.toThrow()
    await expect(ask_user({}, ctx())).rejects.toThrow()
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

describe('web_search', () => {
  afterEach(() => vi.unstubAllGlobals())

  // A realistic slice of DuckDuckGo's HTML endpoint: a uddg-redirect link, a
  // protocol-relative link, and a direct https link — three href shapes.
  const ddgHtml = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">First &amp; Best</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">A <b>great</b> result.</a>
    <a rel="nofollow" class="result__a" href="//example.org/b">Second</a>
    <a class="result__snippet">Plain snippet.</a>
    <a rel="nofollow" class="result__a" href="https://direct.example/c">Third</a>
  `

  it('searches the real endpoint and returns decoded titles, real URLs, and snippets', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(ddgHtml))
    vi.stubGlobal('fetch', fetchMock)
    const out = await web_search({ query: 'last30days skill' }, ctx())
    // It SEARCHES (url-encoded query against the search endpoint), never guesses a domain.
    expect(String(fetchMock.mock.calls[0]![0])).toContain('html.duckduckgo.com/html/?q=last30days%20skill')
    expect(out).toContain('1. First & Best')
    expect(out).toContain('https://example.com/a') // uddg redirect decoded to the real target
    expect(out).toContain('A great result.')
    expect(out).toContain('2. Second')
    expect(out).toContain('https://example.org/b') // protocol-relative href normalized
    expect(out).toContain('3. Third')
    expect(out).toContain('https://direct.example/c') // direct href passed through
    expect(out).not.toContain('duckduckgo.com/l/') // never leaks the redirect wrapper
    expect(out).not.toContain('&amp;') // entities decoded
  })

  it('reports no results when the page has none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>nothing here</body></html>')))
    expect(await web_search({ query: 'zxqwv nope' }, ctx())).toBe('— no results for "zxqwv nope"')
  })

  it('caps results at 8', async () => {
    const many = Array.from({ length: 9 }, (_, i) => `<a class="result__a" href="https://e.test/${i}">R${i}</a>`).join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(many)))
    const out = await web_search({ query: 'many' }, ctx())
    expect(out).toContain('8. R7')
    expect(out).not.toContain('9.')
    expect(out).not.toContain('R8')
  })

  it('description instructs the model to web_fetch the top 3 result URLs', () => {
    const desc = TOOL_DESCRIPTIONS.web_search
    expect(desc).toMatch(/top 3/)
    expect(desc).toMatch(/web_fetch/)
  })
})

describe('bash', () => {
  it('runs a command and captures stdout', async () => {
    expect((await bash({ command: 'echo hi' }, ctx())).trim()).toBe('hi')
  })
  it('appends a non-zero exit marker', async () => {
    expect(await bash({ command: 'exit 3' }, ctx())).toContain('[exit 3]')
  })
  it('truncates very large output with a marker', async () => {
    const out = await bash({ command: 'node -e "process.stdout.write(\'x\'.repeat(20000))"' }, ctx())
    expect(out).toContain('[truncated')
    expect(out.length).toBeLessThan(20000)
  })
})

describe('run_command', () => {
  it('runs a verification command and always appends an exit marker', async () => {
    const out = await run_command({ command: 'node -e "process.stdout.write(\'hi\')"' }, ctx())
    expect(out).toContain('hi')
    expect(out).toMatch(/\[exit 0\]$/)
  })

  it('captures stderr and appends a non-zero exit marker', async () => {
    const out = await run_command(
      { command: 'node -e "process.stderr.write(\'bad\'); process.exit(1)"' },
      ctx(),
    )
    expect(out).toContain('bad')
    expect(out).toMatch(/\[exit 1\]$/)
  })

  it('times out long-running commands and reports a non-zero exit marker', async () => {
    const out = await run_command({ command: 'node -e "setTimeout(() => {}, 1000)"', timeoutMs: 20 }, ctx())
    expect(out).toContain('[timeout after 20ms]')
    expect(out).toMatch(/\[exit 1\]$/)
  })

  it('rejects when the caller aborts the command', async () => {
    const ac = new AbortController()
    const p = run_command({ command: 'node -e "setTimeout(() => {}, 1000)"' }, { ...ctx(), signal: ac.signal })
    setTimeout(() => ac.abort(), 10)
    await expect(p).rejects.toThrow()
  })

  it('truncates very large output with a marker before the exit marker', async () => {
    const out = await run_command({ command: 'node -e "process.stdout.write(\'x\'.repeat(20000))"' }, ctx())
    expect(out).toContain('[truncated')
    expect(out).toMatch(/\[exit 0\]$/)
    expect(out.length).toBeLessThan(20000)
  })

  it('truncates when a later output chunk crosses the cap', async () => {
    const out = await run_command(
      {
        command:
          'node -e "process.stdout.write(\'x\'.repeat(16000)); setTimeout(() => process.stdout.write(\'y\'.repeat(1000)), 10)"',
      },
      ctx(),
    )
    expect(out).toContain('[truncated')
    expect(out).toMatch(/\[exit 0\]$/)
  })
})

describe('runShellCommand', () => {
  it('uses a default timeout when the caller does not pass timeoutMs', async () => {
    const out = await runShellCommand({
      command: 'node -e "setTimeout(() => {}, 1000)"',
      cwd: root,
      defaultTimeoutMs: 20,
      appendExitCode: 'always',
    })
    expect(out).toContain('[timeout after 20ms]')
    expect(out).toMatch(/\[exit 1\]$/)
  })
})
