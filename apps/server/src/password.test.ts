import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password hashing', () => {
  it('verifies a correct password against its hash', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('the-right-one')
    expect(await verifyPassword('the-wrong-one', hash)).toBe(false)
  })

  it('uses a per-password salt — same password hashes to different strings', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
    expect(await verifyPassword('same-password', a)).toBe(true)
    expect(await verifyPassword('same-password', b)).toBe(true)
  })

  it('normalizes unicode so equivalent forms match', async () => {
    // U+00E9 vs e + U+0301 — different bytes, same NFKC normal form.
    const hash = await hashPassword('café')
    expect(await verifyPassword('café', hash)).toBe(true)
  })

  it('returns false (never throws) for malformed stored hashes', async () => {
    expect(await verifyPassword('pw', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('pw', 'bcrypt$aa$bb')).toBe(false)
    expect(await verifyPassword('pw', 'scrypt$$')).toBe(false)
    expect(await verifyPassword('pw', 'scrypt$zz$ab')).toBe(false) // salt decodes to 0 bytes
    expect(await verifyPassword('pw', 'scrypt$ab$zz')).toBe(false) // hash decodes to 0 bytes
  })
})
