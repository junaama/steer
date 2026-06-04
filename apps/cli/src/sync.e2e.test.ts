import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { SteerClient } from './api.js'
import { decodeSessions, type SessionState } from './events.js'
import { resolveSession } from './commands.js'

/**
 * Live-stack integration test for the CLI read path (regression for the
 * "no session matches" / stale `steer ls` bug). It drives the REAL client —
 * SteerClient.shape() -> server `/sync` proxy -> Electric -> Postgres — against
 * the running docker stack, with no service mocks.
 *
 * The bug: the CLI read only Electric's frozen initial shape snapshot and never
 * drained the live log, so sessions created (or renamed) after the shape was
 * first materialized were invisible. We reproduce that exact ordering: create a
 * session, materialize the shape, THEN add another session and rename the first.
 * A correct reader reflects current state; the buggy one returns the stale
 * snapshot.
 *
 * Sessions are seeded directly in Postgres at a terminal status so the agent
 * daemon (which only runs `starting` sessions) never executes them. Requires the
 * stack: `docker compose up -d`. Override endpoints with STEER_SERVER_URL /
 * TEST_DATABASE_URL.
 */
const SERVER_URL = process.env.STEER_SERVER_URL ?? 'http://localhost:8080'
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://steer:steer@localhost:54321/steer?sslmode=disable'

let pool: pg.Pool
let client: SteerClient
let token: string
let userId: string
const email = `cli-itest-${randomUUID()}@steer.dev`
const idA = `sess-itest-${randomUUID()}`
const idB = `sess-itest-${randomUUID()}`

async function seed(id: string, title: string): Promise<void> {
  // 'completed' => terminal => the daemon's intake ignores it (no agent run).
  await pool.query(`insert into sessions (id, user_id, title, model, last_status) values ($1, $2, $3, 'sonnet', 'completed')`, [
    id,
    userId,
    title,
  ])
}

/** Poll the real shape (which now drains to up-to-date) until `pred` holds. */
async function pollSessions(pred: (s: SessionState[]) => boolean, timeoutMs = 15000): Promise<SessionState[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const states = decodeSessions(await client.shape(token, 'sessions'))
    if (pred(states) || Date.now() > deadline) return states
    await new Promise((r) => setTimeout(r, 200))
  }
}

beforeAll(async () => {
  let ok = false
  try {
    ok = (await fetch(`${SERVER_URL}/health`)).ok
  } catch {
    ok = false
  }
  if (!ok) {
    throw new Error(`Live stack not reachable at ${SERVER_URL}/health — start it with \`docker compose up -d\` (or set STEER_SERVER_URL).`)
  }
  pool = new pg.Pool({ connectionString: DB_URL })
  client = new SteerClient({ serverUrl: SERVER_URL })
  const auth = await client.signup(email, 'password123')
  token = auth.token
  userId = auth.user.id
}, 30000)

afterAll(async () => {
  if (pool) {
    await pool.query(`delete from sessions where user_id = $1`, [userId])
    await pool.query(`delete from users where id = $1`, [userId])
    await pool.end()
  }
})

describe('CLI sync read path (live Electric shape)', () => {
  it(
    'reflects sessions and renames made after the shape was first materialized',
    async () => {
      // 1. Seed A and materialize the user's sessions shape (freezes its snapshot baseline).
      await seed(idA, 'alpha original')
      await pollSessions((s) => s.some((x) => x.id === idA))

      // 2. AFTER materialization: add B and rename A. These land in the live log,
      //    past the snapshot — exactly what the old single-shot read never fetched.
      await seed(idB, 'beta')
      await pool.query(`update sessions set title = $1, updated_at = now() where id = $2`, ['alpha renamed', idA])

      // 3. The real CLI read must drain the shape to up-to-date and reflect current state.
      const states = await pollSessions((s) => s.some((x) => x.id === idB) && s.some((x) => x.id === idA && x.title === 'alpha renamed'))

      const a = states.find((x) => x.id === idA)
      const b = states.find((x) => x.id === idB)
      expect(b, 'a session created after the shape was materialized must be visible to `steer ls`').toBeDefined()
      expect(a?.title, 'a rename made after materialization must be reflected').toBe('alpha renamed')

      // 4. resolveSession (powering `--session <id|name>`) finds the post-materialization session.
      expect(resolveSession(states, idB)).toEqual({ id: idB })
      expect(resolveSession(states, 'alpha renamed')).toEqual({ id: idA })
    },
    40000,
  )
})
