import pg from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sessions, events, controls, environments } from '@steer/schema'

const schema = { sessions, events, controls, environments }
export type Db = NodePgDatabase<typeof schema>

export function createPool(connectionString: string | undefined = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  return new pg.Pool({ connectionString })
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema })
}
