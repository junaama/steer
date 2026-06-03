import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

// scrypt with the Node defaults (N=16384, r=8, p=1) — a deliberately slow,
// memory-hard KDF. No external dependency; uses only node:crypto.
const KEY_LEN = 64
const SALT_LEN = 16

/**
 * Hash a password for storage. The salt is generated per-password and stored
 * alongside the derived key in a self-describing `scrypt$<salt>$<hash>` string,
 * so {@link verifyPassword} needs nothing else to check it.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const derived = (await scryptAsync(password.normalize('NFKC'), salt, KEY_LEN)) as Buffer
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

/**
 * Constant-time verification of a password against a stored hash. Returns false
 * (never throws) for any malformed stored value, so a corrupt row can't crash
 * the login path.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  if (salt.length === 0 || expected.length === 0) return false
  const derived = (await scryptAsync(password.normalize('NFKC'), salt, expected.length)) as Buffer
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}
