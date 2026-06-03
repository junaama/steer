import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createPool, createDb } from './db.js'

async function main(): Promise<void> {
  const pool = createPool()
  const db = createDb(pool)
  await migrate(db, { migrationsFolder: './drizzle' })
  await pool.end()
  // eslint-disable-next-line no-console
  console.log('[migrate] done')
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] failed', err)
  process.exit(1)
})
