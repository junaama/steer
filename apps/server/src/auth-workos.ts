import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { AuthVerifier } from './auth.js'

/**
 * Verify WorkOS AuthKit access tokens against the WorkOS JWKS. The JWT `sub`
 * claim is the per-user identity that scopes every read/write. `jwtVerify`
 * checks the signature and expiry; anything that fails resolves to null (the
 * preHandler turns that into a 401).
 *
 * `jwks` is injectable so tests can verify against a locally-generated key set
 * without hitting the network; production uses the cached remote JWKS.
 */
export function createWorkosVerifier(opts: { clientId: string; jwks?: JWTVerifyGetKey }): AuthVerifier {
  const jwks =
    opts.jwks ?? createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${opts.clientId}`))

  return {
    verify: async (token) => {
      try {
        const { payload } = await jwtVerify(token, jwks)
        if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null
        return { sub: payload.sub }
      } catch {
        return null
      }
    },
  }
}
