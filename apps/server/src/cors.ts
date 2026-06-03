import type { FastifyInstance } from 'fastify'
import './types.js'

const ALLOW_METHODS = 'GET, POST, OPTIONS'
const ALLOW_HEADERS = 'authorization, content-type'
const MAX_AGE = '86400'

/**
 * Browser CORS for the cross-origin web app. The UI origin is never the same as
 * the API origin in any configuration here (web on :5173 or a host dev port,
 * server on :8080), so the browser CORS-guards every `/sync` read and `/writes`
 * call. Identity rides on a bearer token — never a cookie — so requests are
 * non-credentialed; we reflect the request `Origin` rather than maintain an
 * allow-list, and expose all response headers so the Electric client can read
 * its `electric-*` sync cursors cross-origin.
 *
 * Registered as `onRequest` (before the auth `preHandler`) so a CORS preflight —
 * an `OPTIONS` the browser sends WITHOUT the bearer token — short-circuits here
 * with 204 instead of hitting the auth gate on `/writes` and `/sync`. Without
 * this, the preflight would 401 and the browser would never send the real
 * request.
 */
export function registerCors(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (origin === undefined) return undefined // same-origin / non-browser caller

    reply.header('access-control-allow-origin', origin)
    reply.header('access-control-expose-headers', '*')

    if (req.method === 'OPTIONS') {
      reply
        .header('access-control-allow-methods', ALLOW_METHODS)
        .header('access-control-allow-headers', ALLOW_HEADERS)
        .header('access-control-max-age', MAX_AGE)
        .code(204)
        .send()
      return reply
    }
    return undefined
  })
}
