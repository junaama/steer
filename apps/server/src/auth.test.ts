import { describe, it, expect } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { bearerToken, createPlaceholderVerifier } from './auth.js'

function reqWith(authorization?: string): FastifyRequest {
  return { headers: authorization ? { authorization } : {} } as FastifyRequest
}

describe('bearerToken', () => {
  it('extracts a bearer token', () => {
    expect(bearerToken(reqWith('Bearer abc123'))).toBe('abc123')
  })
  it('returns null when the header is missing or not a bearer', () => {
    expect(bearerToken(reqWith())).toBeNull()
    expect(bearerToken(reqWith('Basic xyz'))).toBeNull()
  })
  it('returns null for an empty bearer token', () => {
    expect(bearerToken(reqWith('Bearer '))).toBeNull()
  })
})

describe('createPlaceholderVerifier', () => {
  it('rejects every token', async () => {
    expect(await createPlaceholderVerifier().verify('anything')).toBeNull()
  })
})
