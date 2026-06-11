import { homedir } from 'node:os'
import { resolve, relative, isAbsolute, join } from 'node:path'

/**
 * Resolve a tool `path` for execution. Relative paths resolve against `base` (the
 * session's working directory — the cwd the CLI was launched from); absolute
 * paths are taken as-is. The result is then confined to `root` (the daemon's
 * sandbox boundary): a path under `root` but outside `base` is allowed — that is
 * how a session reaches a sibling directory ("request broader scope") — while a
 * path above `root` is refused. When a daemon has no broader root than the
 * session dir, callers pass `base` as `root` and this is exactly the old
 * per-directory sandbox.
 */
function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

export function safeJoin(root: string, base: string, path: string, home: string = homedir()): string {
  const full = resolve(base, expandHome(path, home))
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${path}`)
  return full
}
