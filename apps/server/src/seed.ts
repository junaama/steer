import { createPool, createDb } from './db.js'
import { seedDemo } from './seed-demo.js'

/**
 * Deterministic demo seed — cold-start proof, integration fixture, and Loom
 * script in one. Set SEED_USER_ID to your WorkOS user id (the JWT `sub`) to see
 * these in the UI after login; otherwise they belong to the default 'demo-user'.
 */
const DEMO_USER = process.env.SEED_USER_ID ?? 'demo-user'

async function main(): Promise<void> {
  const pool = createPool()
  const db = createDb(pool)
  await seedDemo(db, DEMO_USER)
  await pool.end()
  // eslint-disable-next-line no-console
  console.log(`[seed] done (user=${DEMO_USER})`)
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed', err)
  process.exit(1)
})
