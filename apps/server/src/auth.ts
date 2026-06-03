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
 * Placeholder verifier used until U4 wires the real WorkOS JWKS verification.
 * Rejects everything, so the server boots but protected routes 401 until then.
 */
export function createPlaceholderVerifier(): AuthVerifier {
  return { verify: async () => null }
}
