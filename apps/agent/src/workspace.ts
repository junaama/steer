import { resolve, relative, isAbsolute } from 'node:path'

/**
 * The coding agent operates on the environment the daemon is launched in — its
 * current working directory — not an isolated temp dir. This is the PRD's "runs
 * the sessions on the host it's running on": `list_dir`, `bash`, `read_file`,
 * `write_file` all act on real files where the daemon process runs (the repo on
 * a workstation, `/app` in the container, or a mounted project).
 *
 * `STEER_WORKSPACE_ROOT` overrides it. Empty/whitespace is treated as unset,
 * because docker-compose injects `${STEER_WORKSPACE_ROOT:-}` as `""`.
 */
export function resolveWorkspaceRoot(
  env: { STEER_WORKSPACE_ROOT?: string } = {},
  cwd: () => string = process.cwd,
): string {
  const configured = env.STEER_WORKSPACE_ROOT?.trim()
  return configured ? configured : cwd()
}

/**
 * The directory a session runs in: its `workdir` (the cwd the CLI was launched
 * from) when that resolves inside the daemon's `root`, else the `root` itself.
 * A workdir outside the root is ignored — a session routed to a daemon can never
 * operate on a path that daemon does not have. `root` remains the sandbox
 * boundary, so a session can still reach siblings under the root.
 */
export function resolveSessionWorkspace(root: string, workdir: string | null | undefined): string {
  if (!workdir) return root
  const full = resolve(workdir)
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) return root
  return full
}
