import { eq } from 'drizzle-orm'
import { sessions, events } from '@steer/schema'
import { createPool, createDb } from './db.js'

/**
 * Deterministic demo seed — cold-start proof, integration fixture, and Loom
 * script in one. Idempotent (clears the demo user's sessions first).
 *
 * Set SEED_USER_ID to your WorkOS user id (the JWT `sub`) to see these in the
 * UI after login; otherwise they belong to the default 'demo-user'.
 */
const DEMO_USER = process.env.SEED_USER_ID ?? 'demo-user'

async function main(): Promise<void> {
  const pool = createPool()
  const db = createDb(pool)

  await db.delete(sessions).where(eq(sessions.userId, DEMO_USER))

  // A fresh task the agent daemon will pick up and stream live (the headline demo).
  await db.insert(sessions).values({
    id: 'seed-add-auth',
    userId: DEMO_USER,
    title: 'Add session-aware auth',
    task: 'login() returns null even when a valid session exists — make it return the active session.',
    lastStatus: 'starting',
    model: 'sonnet',
  })

  // A finished session with a pre-rendered trace.
  await db.insert(sessions).values({
    id: 'seed-fix-checkout',
    userId: DEMO_USER,
    title: 'Fix flaky checkout test',
    lastStatus: 'completed',
    model: 'sonnet',
  })
  await db.insert(events).values([
    { sessionId: 'seed-fix-checkout', seq: 0, type: 'message', payload: { text: 'The flake is a race on the cart-clear call. I added an await and the test is green across 50 runs.' } },
    { sessionId: 'seed-fix-checkout', seq: 1, type: 'tool_proposed', payload: { toolCallId: 't1', name: 'grep', kind: 'read-only', args: { pattern: 'cartClear', path: 'tests/' } } },
    { sessionId: 'seed-fix-checkout', seq: 2, type: 'tool_result', payload: { toolCallId: 't1', name: 'grep', result: 'tests/checkout.test.ts:88: cartClear()\n— 1 match' } },
    { sessionId: 'seed-fix-checkout', seq: 3, type: 'message', payload: { text: 'Done — 50/50 passing. Closed out.' } },
  ])

  await pool.end()
  // eslint-disable-next-line no-console
  console.log(`[seed] done (user=${DEMO_USER})`)
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed', err)
  process.exit(1)
})
