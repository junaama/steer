import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { sessions } from '@steer/schema'
import type { Db } from './db.js'
import './types.js'

export type FetchImpl = typeof fetch

const COLLECTIONS = new Set(['sessions', 'events', 'controls', 'environments'])
// Electric cursor/live params the client controls; everything safety-relevant
// (table + where) is authored server-side and never trusted from the client.
const PASSTHROUGH = ['offset', 'handle', 'live', 'cursor', 'replica'] as const

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Electric is public by default; this proxy is the only way in. It verifies the
 * authenticated user, injects the WHERE clause server-side (the client cannot
 * author a filter), and adds `Vary: Authorization` so a cache never serves one
 * user's rows to another.
 */
export function registerProxy(
  app: FastifyInstance,
  opts: { db: Db; electricUrl: string; fetchImpl?: FetchImpl },
): void {
  const fetchImpl = opts.fetchImpl ?? fetch

  app.get('/sync/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!COLLECTIONS.has(collection)) return reply.code(404).send({ error: 'unknown collection' })

    const query = req.query as Record<string, string | undefined>
    let where: string

    if (collection === 'sessions') {
      where = `user_id = ${sqlLiteral(req.userId)}`
    } else if (collection === 'environments') {
      // Global registry — every authenticated user sees all registered environments (R2).
      where = '1 = 1'
    } else {
      const sessionId = query.session_id
      if (!sessionId) return reply.code(400).send({ error: 'session_id required' })
      const owns = await opts.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, req.userId)))
      if (owns.length === 0) return reply.code(403).send({ error: 'forbidden' })
      where = `session_id = ${sqlLiteral(sessionId)}`
    }

    const url = new URL('/v1/shape', opts.electricUrl)
    url.searchParams.set('table', collection)
    url.searchParams.set('where', where)
    for (const key of PASSTHROUGH) {
      const v = query[key]
      if (v !== undefined) url.searchParams.set(key, v)
    }
    if (!url.searchParams.has('offset')) url.searchParams.set('offset', '-1')

    const upstream = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } })

    reply.header('vary', 'Authorization')
    upstream.headers.forEach((value, key) => {
      if (key.startsWith('electric-') || key === 'content-type' || key === 'cache-control') {
        reply.header(key, value)
      }
    })
    reply.code(upstream.status)
    return reply.send(await upstream.text())
  })
}
