/**
 * Resolve an environment routing id from a raw value (e.g. `STEER_ENV` or a CLI
 * `--env` flag). A trimmed, non-empty string is the environment id; anything empty
 * is the "default daemon" / "unrouted" sentinel, represented as `null`.
 *
 * Pure and web-safe (no `os` import) so the CLI, the agent, and the browser bundle
 * can all share it. Node callers that want a hostname fallback for the *claim
 * owner* supply it themselves — this helper only normalizes the routing key.
 */
export function resolveEnvironmentId(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
