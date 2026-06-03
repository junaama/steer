import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { users } from '@steer/schema'
import type { Db } from './db.js'
import { hashPassword, verifyPassword } from './password.js'
import { bearerToken } from './auth.js'
import { generateSessionToken, createSession, invalidateSession } from './auth-session.js'
import './types.js'

const credentialsSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
})

/**
 * A fixed dummy hash, computed once, that login verifies against when no user
 * matches the email. Keeping the work identical whether or not the account
 * exists denies an attacker a timing oracle for enumerating registered emails.
 */
const DUMMY_HASH = hashPassword('not-a-real-password-timing-equalizer')

/**
 * Email/password auth endpoints. These are intentionally NOT behind the auth
 * gate (`/auth/me` is the one exception — see app.ts), since signup and login
 * are how a client first obtains a token. The token is returned in the body and
 * the SPA attaches it as a bearer on every subsequent API/sync request.
 */
export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  app.post('/auth/signup', async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid credentials', detail: parsed.error.flatten() })
    }
    const email = parsed.data.email.toLowerCase()

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
    if (existing.length > 0) return reply.code(409).send({ error: 'email already registered' })

    const id = randomUUID()
    await db.insert(users).values({ id, email, passwordHash: await hashPassword(parsed.data.password) })

    const token = generateSessionToken()
    await createSession(db, token, id)
    return reply.code(201).send({ token, user: { id, email } })
  })

  app.post('/auth/login', async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(401).send({ error: 'invalid email or password' })
    const email = parsed.data.email.toLowerCase()

    const rows = await db.select().from(users).where(eq(users.email, email))
    const user = rows[0]
    const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? (await DUMMY_HASH))
    if (!user || !ok) return reply.code(401).send({ error: 'invalid email or password' })

    const token = generateSessionToken()
    await createSession(db, token, user.id)
    return reply.send({ token, user: { id: user.id, email: user.email } })
  })

  app.post('/auth/logout', async (req, reply) => {
    const token = bearerToken(req)
    if (token) await invalidateSession(db, token)
    return reply.code(204).send()
  })

  // Gated by `protect` in app.ts, so `req.userId` is already the verified subject.
  // The SPA calls this on load to restore (or discard) a persisted token.
  app.get('/auth/me', async (req, reply) => {
    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, req.userId))
    const user = rows[0]
    if (!user) return reply.code(401).send({ error: 'unauthorized' })
    return reply.send({ user })
  })
}
