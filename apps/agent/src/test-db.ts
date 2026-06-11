import pg from 'pg'

const DEFAULT_TEST_DATABASE_URL = 'postgresql://steer:steer@localhost:54321/steer_agent_test?sslmode=disable'

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL
}

function adminDatabaseUrl(url: string): string {
  const parsed = new URL(url)
  parsed.pathname = '/postgres'
  return parsed.toString()
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

export async function ensureDefaultTestDatabase(): Promise<void> {
  if (process.env.TEST_DATABASE_URL) return
  const url = testDatabaseUrl()
  const database = new URL(url).pathname.slice(1)
  const pool = new pg.Pool({ connectionString: adminDatabaseUrl(url) })
  try {
    await pool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
  } catch (err) {
    if ((err as { code?: string }).code !== '42P04') throw err
  } finally {
    await pool.end()
  }
}
