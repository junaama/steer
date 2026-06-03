import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { read_file, list_dir, grep, glob, web_fetch, write_file, bash } from './index.js'

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
