import { randomBytes, createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { users, authSessions } from '@steer/schema'
import type { Db } from './db.js'
import type { AuthVerifier } from './auth.js'

/**
 * Self-hosted session auth
 *
 * The client holds a high-entropy opaque token; the server stores only its
 * SHA-256 hash as the session id. A database read therefore never exposes a
 * usable token. Verification hashes the presented token and looks the row up by
 * that hash — there is no signing secret to manage, so no extra env var is
 * required for auth to work.
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const SESSION_TTL_MS = 30 * DAY_MS
// Slide the expiry forward once a session is within this window of expiring, so
// active users stay logged in without minting a new token on every request.
const RENEW_WITHIN_MS = 15 * DAY_MS

export interface SessionUser {
  id: string
  email: string
}

/** A new bearer secret. base64url so it travels safely in an Authorization header. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** The persisted session id: the SHA-256 hash (hex) of the token. */
export function sessionIdFromToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Persist a session for `userId`, keyed by the hash of `token`. */
export async function createSession(
  db: Db,
  token: string,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.insert(authSessions).values({
    id: sessionIdFromToken(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  })
}

/**
 * Resolve a token to its user, or null if the session is unknown or expired.
 * Expired sessions are deleted on read; live sessions inside the renewal window
 * have their expiry slid forward (sliding expiration).
 */
export async function validateSessionToken(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<SessionUser | null> {
  const id = sessionIdFromToken(token)
  const rows = await db
    .select({
      userId: authSessions.userId,
      expiresAt: authSessions.expiresAt,
      email: users.email,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(eq(authSessions.id, id))

  const row = rows[0]
  if (!row) return null

  if (now.getTime() >= row.expiresAt.getTime()) {
    await db.delete(authSessions).where(eq(authSessions.id, id))
    return null
  }

  if (row.expiresAt.getTime() - now.getTime() < RENEW_WITHIN_MS) {
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(authSessions.id, id))
  }

  return { id: row.userId, email: row.email }
}

/** Drop a single session (logout). No-op if the token is unknown. */
export async function invalidateSession(db: Db, token: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.id, sessionIdFromToken(token)))
}

/**
 * The {@link AuthVerifier} the rest of the server depends on. Slots into
 * `registerAuth` exactly where the WorkOS JWKS verifier used to, exposing the
 * `users.id` as the request `sub` that scopes every read/write.
 */
export function createSessionVerifier(db: Db): AuthVerifier {
  return {
    verify: async (token) => {
      const user = await validateSessionToken(db, token)
      return user ? { sub: user.id } : null
    },
  }
}
