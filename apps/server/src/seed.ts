import { createPool, createDb } from './db.js'
import { ensureUser, seedDemo } from './seed-demo.js'

/**
 * Deterministic demo seed — cold-start proof, integration fixture, and Loom
 * script in one. Creates a login-able demo account and seeds its sessions, so a
 * reviewer can sign in with the credentials below and immediately see data.
 * (Signing up a fresh account works too — the seed is purely a convenience.)
 */
const EMAIL = process.env.SEED_USER_EMAIL ?? 'demo@steer.dev'
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'steerdemo123'

async function main(): Promise<void> {
  const pool = createPool()
  const db = createDb(pool)
  const userId = await ensureUser(db, EMAIL, PASSWORD)
  await seedDemo(db, userId)
  await pool.end()
  // eslint-disable-next-line no-console
  console.log(`[seed] done — log in with ${EMAIL} / ${PASSWORD}`)
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed', err)
  process.exit(1)
})
