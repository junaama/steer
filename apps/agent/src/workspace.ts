import { resolve, relative, isAbsolute } from 'node:path'

/**
 * The coding agent operates on the daemon host filesystem, not an isolated temp
 * dir. By default, that boundary is the host root so client-created sessions can
 * choose any daemon-visible working directory.
 *
 * `STEER_WORKSPACE_ROOT` overrides it. Empty/whitespace is treated as unset,
 * because docker-compose injects `${STEER_WORKSPACE_ROOT:-}` as `""`.
 */
export function resolveWorkspaceRoot(env: { STEER_WORKSPACE_ROOT?: string } = {}): string {
  const configured = env.STEER_WORKSPACE_ROOT?.trim()
  return configured ? configured : '/'
}

/**
 * The directory a session runs in: its `workdir` (the cwd the CLI was launched
 * from) when that resolves inside the daemon's `root`, else the `root` itself.
 * A workdir outside the daemon root is ignored: the session runs at the root
 * instead. `root` stays the sandbox boundary, so a session can still reach
 * siblings under it.
 */
export function resolveSessionWorkspace(root: string, workdir: string | null | undefined): string {
  if (!workdir) return root
  const abs = resolve(workdir)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return root
  return abs
}
