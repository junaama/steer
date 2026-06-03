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
