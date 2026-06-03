import { eq } from 'drizzle-orm'
import { sessions, events } from '@steer/schema'
import type { Db } from './db.js'

/**
 * Seed a user's demo sessions. Idempotent — clears the user's existing sessions
 * first. Session ids are namespaced by user so seeding different users never
 * collides.
 */
export async function seedDemo(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))

  const addAuth = `seed-${userId}-add-auth`
  const fixCheckout = `seed-${userId}-fix-checkout`

  // A fresh task the agent daemon will pick up and stream live (the headline demo).
  await db.insert(sessions).values({
    id: addAuth,
    userId,
    title: 'Add session-aware auth',
    task: 'login() returns null even when a valid session exists — make it return the active session.',
    lastStatus: 'starting',
    model: 'sonnet',
  })

  // A finished session with a pre-rendered trace.
  await db.insert(sessions).values({
    id: fixCheckout,
    userId,
    title: 'Fix flaky checkout test',
    lastStatus: 'completed',
    model: 'sonnet',
  })
  await db.insert(events).values([
    { sessionId: fixCheckout, seq: 0, type: 'message', payload: { text: 'The flake is a race on the cart-clear call. I added an await and the test is green across 50 runs.' } },
    { sessionId: fixCheckout, seq: 1, type: 'tool_proposed', payload: { toolCallId: 't1', name: 'grep', kind: 'read-only', args: { pattern: 'cartClear', path: 'tests/' } } },
    { sessionId: fixCheckout, seq: 2, type: 'tool_result', payload: { toolCallId: 't1', name: 'grep', result: 'tests/checkout.test.ts:88: cartClear()\n— 1 match' } },
    { sessionId: fixCheckout, seq: 3, type: 'message', payload: { text: 'Done — 50/50 passing. Closed out.' } },
  ])
}
