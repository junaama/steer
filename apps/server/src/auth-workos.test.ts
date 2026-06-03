import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey, type KeyLike } from 'jose'
import { createWorkosVerifier } from './auth-workos.js'

let realKey: KeyLike
let forgedKey: KeyLike
let jwks: JWTVerifyGetKey

async function sign(key: KeyLike, claims: Record<string, unknown>, expSeconds = 3600): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
    .sign(key)
}

beforeAll(async () => {
  const real = await generateKeyPair('RS256')
  const forged = await generateKeyPair('RS256')
  realKey = real.privateKey
  forgedKey = forged.privateKey
  const jwk = await exportJWK(real.publicKey)
  jwk.kid = 'test-key'
  jwks = createLocalJWKSet({ keys: [jwk] })
})

describe('createWorkosVerifier', () => {
  it('accepts a valid token and returns its sub', async () => {
    const verifier = createWorkosVerifier({ clientId: 'client_test', jwks })
    const token = await sign(realKey, { sub: 'user_123' })
    expect(await verifier.verify(token)).toEqual({ sub: 'user_123' })
  })

  it('rejects an expired token', async () => {
    const verifier = createWorkosVerifier({ clientId: 'client_test', jwks })
    const token = await sign(realKey, { sub: 'user_123' }, -10)
    expect(await verifier.verify(token)).toBeNull()
  })

  it('rejects a token signed by the wrong key (forged)', async () => {
    const verifier = createWorkosVerifier({ clientId: 'client_test', jwks })
    const token = await sign(forgedKey, { sub: 'user_123' })
    expect(await verifier.verify(token)).toBeNull()
  })

  it('rejects a token with no sub claim', async () => {
    const verifier = createWorkosVerifier({ clientId: 'client_test', jwks })
    const token = await sign(realKey, {})
    expect(await verifier.verify(token)).toBeNull()
  })

  it('rejects a malformed token without hitting the network', async () => {
    const verifier = createWorkosVerifier({ clientId: 'client_test' }) // remote JWKS branch
    expect(await verifier.verify('not.a.jwt')).toBeNull()
    expect(await verifier.verify('')).toBeNull()
  })
})
