/**
 * Session-restore decision logic.
 *
 * On load the SPA probes `/auth/me` with its persisted bearer token to decide
 * whether the saved session is still good. The distinction that matters — and
 * that the previous code got wrong — is between a token that is *invalid* and a
 * server that is *temporarily unreachable*:
 *
 * - A 401/403 means the token is genuinely expired or revoked. Discard it so the
 *   user re-authenticates.
 * - A network error (the server is mid-restart during `docker compose up`), a
 *   5xx, or any other non-2xx is "can't verify right now". KEEP the token — a
 *   brief server bounce must never delete it, otherwise every `up` logs the user
 *   out even though their session row is alive in Postgres.
 *
 * This is a pure function so the policy is unit-tested independently of the
 * fetch/React shell in {@link ./AuthProvider}.
 */

export interface AuthUser {
  id: string
  email: string
}

/** The outcome of probing `/auth/me`: a reached response, or a network failure. */
export type MeProbe =
  | { ok: true; status: number; user: AuthUser | null }
  | { ok: false }

/**
 * What the shell should do with the persisted token:
 * - `authed`  — token valid; sign the user in.
 * - `clear`   — token invalid (401/403); remove it and show the sign-in gate.
 * - `keep`    — verification was inconclusive (offline / 5xx); preserve the
 *               token so a later reload restores the session.
 */
export type RestoreDecision =
  | { kind: 'authed'; user: AuthUser }
  | { kind: 'clear' }
  | { kind: 'keep' }

export function decideRestore(probe: MeProbe): RestoreDecision {
  // Server unreachable (fetch rejected) — keep the token; do not log out.
  if (!probe.ok) return { kind: 'keep' }
  // The only case that justifies discarding the token: it was explicitly rejected.
  if (probe.status === 401 || probe.status === 403) return { kind: 'clear' }
  // A confirmed identity.
  if (probe.user) return { kind: 'authed', user: probe.user }
  // Reached but inconclusive (5xx, or 2xx without a user body) — keep the token.
  return { kind: 'keep' }
}
