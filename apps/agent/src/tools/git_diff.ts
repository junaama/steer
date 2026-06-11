import { spawn } from 'node:child_process'
import { relative } from 'node:path'
import { validateToolArgs } from '@steer/schema'
import type { ToolFn, ToolContext } from './index.js'
import { safeJoin } from './paths.js'

/** The sandbox root for a context — the broad daemon root, or the session dir. */
function sandboxRoot(ctx: ToolContext): string {
  return ctx.root ?? ctx.workspaceRoot
}

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run `git` with the given argv inside the workspace. Args are passed to the
 * process directly (never through a shell), so a `path` can't inject a command.
 * Rejects only on spawn/abort failure; a non-zero git exit resolves with its
 * captured stderr so callers can classify it (e.g. "not a git repository").
 */
function runGit(argv: string[], ctx: ToolContext): Promise<GitResult> {
  return new Promise<GitResult>((resolvePromise, reject) => {
    const child = spawn('git', argv, { cwd: ctx.workspaceRoot, signal: ctx.signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    // 'error' (spawn failure / abort) and 'close' (process exited) are mutually
    // exclusive; the Promise settles once and a later callback is a no-op.
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ stdout, stderr, exitCode: code ?? 1 }))
  })
}

/** A non-zero git exit whose stderr says the workspace isn't a git repository. */
function isNotARepo(stderr: string): boolean {
  return /not a git repository/i.test(stderr)
}

/**
 * Report the workspace's current git working-tree diff (R12). Read-only: it runs
 * `git diff` (adds `--staged` for the index, `-- <path>` to scope) within the
 * workspace and returns the unified diff text. A `path` is confined to the
 * workspace root via safeJoin (returns an error string on traversal, never an
 * exception). Degrades to clear messages when there are no changes or the
 * workspace isn't a git repo, rather than throwing.
 */
export const git_diff: ToolFn = async (args, ctx) => {
  const { staged, path } = validateToolArgs('git_diff', args) as { staged?: boolean; path?: string }

  const argv = ['diff']
  if (staged) argv.push('--staged')
  if (path !== undefined) {
    let resolved: string
    try {
      // safeJoin throws an Error whose message names the escaping path.
      resolved = safeJoin(sandboxRoot(ctx), ctx.workspaceRoot, path, ctx.homeDir)
    } catch (err) {
      return `error: ${(err as Error).message}`
    }
    // Pass git a workspace-relative pathspec; the arg goes to the process
    // directly (no shell), so it can't break out into a second command. An
    // empty relative path (the workspace root itself) becomes '.'.
    argv.push('--', relative(ctx.workspaceRoot, resolved) || '.')
  }

  const { stdout, stderr, exitCode } = await runGit(argv, ctx)
  if (exitCode !== 0) {
    if (isNotARepo(stderr)) return 'Not a git repository — git_diff is unavailable here.'
    return `error: git diff failed${stderr ? `: ${stderr.trim()}` : ''}`
  }
  if (stdout.trim() === '') return 'No changes in the working tree.'
  return stdout
}
