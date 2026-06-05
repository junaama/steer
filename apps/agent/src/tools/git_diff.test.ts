import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, chmod } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git_diff } from './git_diff.js'
import { classifyTool, isReadOnly, TOOL_DESCRIPTIONS } from '@steer/schema'

/** Run a git command synchronously in `cwd`, asserting it succeeds. */
function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
}

/** A fresh git repo with one committed file and an uncommitted edit on top. */
async function makeDirtyRepo(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'steer-gitdiff-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@steer.local')
  git(root, 'config', 'user.name', 'Steer Test')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'login.ts'), 'export const login = () => null\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'initial')
  // Uncommitted working-tree change.
  await writeFile(join(root, 'src', 'login.ts'), 'export const login = () => ({ ok: true })\n')
  return { root }
}

const ctx = (root: string) => ({ workspaceRoot: root })

// Some tests shim a fake `git` onto PATH; this restores the original after each.
let restorePath: (() => void) | undefined
afterEach(() => {
  restorePath?.()
  restorePath = undefined
})

describe('git_diff policy', () => {
  it('is classified read-only (no approval gate)', () => {
    expect(classifyTool('git_diff')).toBe('read-only')
    expect(isReadOnly('git_diff')).toBe(true)
  })

  it('has an action-oriented description mentioning staged and path', () => {
    expect(TOOL_DESCRIPTIONS.git_diff).toMatch(/git diff/i)
    expect(TOOL_DESCRIPTIONS.git_diff).toMatch(/staged/i)
    expect(TOOL_DESCRIPTIONS.git_diff).toMatch(/path/i)
  })
})

describe('git_diff', () => {
  it('returns a unified diff naming the changed file (unstaged by default)', async () => {
    const { root } = await makeDirtyRepo()
    const out = await git_diff({}, ctx(root))
    expect(out).toContain('diff --git')
    expect(out).toContain('src/login.ts')
    expect(out).toContain('+export const login = () => ({ ok: true })')
    expect(out).toContain('-export const login = () => null')
  })

  it('returns the staged diff with staged:true', async () => {
    const { root } = await makeDirtyRepo()
    // Stage the change; the unstaged diff is now empty, the staged diff shows it.
    git(root, 'add', 'src/login.ts')
    expect(await git_diff({}, ctx(root))).toBe('No changes in the working tree.')
    const staged = await git_diff({ staged: true }, ctx(root))
    expect(staged).toContain('diff --git')
    expect(staged).toContain('src/login.ts')
    expect(staged).toContain('+export const login = () => ({ ok: true })')
  })

  it('scopes the diff to a sub-path and excludes other changes', async () => {
    const { root } = await makeDirtyRepo()
    // A second uncommitted change outside src/.
    await writeFile(join(root, 'README.md'), '# changed\n')
    const scoped = await git_diff({ path: 'src' }, ctx(root))
    expect(scoped).toContain('src/login.ts')
    expect(scoped).not.toContain('README.md')
  })

  it('treats a "." path as the whole workspace', async () => {
    const { root } = await makeDirtyRepo()
    const out = await git_diff({ path: '.' }, ctx(root))
    expect(out).toContain('src/login.ts')
  })

  it('reports a clear message when the working tree has no changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'steer-gitclean-'))
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@steer.local')
    git(root, 'config', 'user.name', 'Steer Test')
    await writeFile(join(root, 'a.txt'), 'stable\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'initial')
    expect(await git_diff({}, ctx(root))).toBe('No changes in the working tree.')
  })

  it('reports "not a git repository" rather than throwing outside a repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'steer-nogit-'))
    await writeFile(join(root, 'plain.txt'), 'no repo here\n')
    const out = await git_diff({}, ctx(root))
    expect(out).toMatch(/not a git repository/i)
  })

  it('rejects path traversal outside the workspace with an error string (no throw)', async () => {
    const { root } = await makeDirtyRepo()
    const out = await git_diff({ path: '../outside' }, ctx(root))
    expect(out).toMatch(/^error: /)
    expect(out).toMatch(/escapes/)
  })

  it('returns an error string when git fails for a non-repo reason', async () => {
    // Shim a fake `git` earlier on PATH that exits non-zero with non-"repo"
    // stderr — exercising the generic git-failure branch deterministically,
    // without depending on a hard-to-provoke real git error.
    const binDir = await mkdtemp(join(tmpdir(), 'steer-fakegit-'))
    const fakeGit = join(binDir, 'git')
    await writeFile(fakeGit, '#!/bin/sh\necho "fatal: something went wrong" >&2\nexit 128\n')
    await chmod(fakeGit, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
    restorePath = () => {
      process.env.PATH = originalPath
    }
    const root = await mkdtemp(join(tmpdir(), 'steer-gitgeneric-'))
    const out = await git_diff({}, ctx(root))
    expect(out).toMatch(/^error: git diff failed/)
    expect(out).toContain('something went wrong')
  })

  it('reports a bare failure when git dies via signal with no stderr', async () => {
    // A fake `git` that emits nothing and kills itself with a signal: the
    // process closes with a null exit code (→ treated non-zero) and empty
    // stderr, exercising the no-stderr failure message.
    const binDir = await mkdtemp(join(tmpdir(), 'steer-fakegit-sig-'))
    const fakeGit = join(binDir, 'git')
    await writeFile(fakeGit, '#!/bin/sh\nkill -TERM $$\n')
    await chmod(fakeGit, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
    restorePath = () => {
      process.env.PATH = originalPath
    }
    const root = await mkdtemp(join(tmpdir(), 'steer-gitsignal-'))
    const out = await git_diff({}, ctx(root))
    expect(out).toBe('error: git diff failed')
  })

  it('rejects when the caller aborts the diff', async () => {
    const { root } = await makeDirtyRepo()
    const ac = new AbortController()
    ac.abort()
    await expect(git_diff({}, { ...ctx(root), signal: ac.signal })).rejects.toThrow()
  })

  it('validates args (staged must be a boolean)', async () => {
    const { root } = await makeDirtyRepo()
    await expect(git_diff({ staged: 'yes' }, ctx(root))).rejects.toThrow()
    await expect(git_diff({ path: '' }, ctx(root))).rejects.toThrow()
  })
})
