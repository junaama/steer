import type { FastifyInstance, FastifyRequest } from 'fastify'
import './types.js'

export interface AuthVerifier {
  /** Resolve a bearer token to its claims, or null if invalid/expired. */
  verify(token: string): Promise<{ sub: string } | null>
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

/**
 * Gate protected routes on a valid bearer token. On success, `request.userId`
 * carries the verified subject; downstream handlers scope every read/write to it.
 */
export function registerAuth(
  app: FastifyInstance,
  verifier: AuthVerifier,
  opts: { protect: (url: string) => boolean },
): void {
  app.decorateRequest('userId', '')
  app.addHook('preHandler', async (req, reply) => {
    if (!opts.protect(req.url)) return
    const token = bearerToken(req)
    const claims = token ? await verifier.verify(token) : null
    if (!claims) {
      await reply.code(401).send({ error: 'unauthorized' })
      return reply
    }
    req.userId = claims.sub
    return undefined
  })
}

/**
 * A verifier that rejects every token. Handy as a safe default and in tests
 * that need protected routes to 401 without standing up real auth.
 */
export function createPlaceholderVerifier(): AuthVerifier {
  return { verify: async () => null }
}
