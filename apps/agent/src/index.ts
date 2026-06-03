import { createPool, createDb } from './db.js'
import { pollAndRun } from './daemon.js'

// Agent daemon — PORTLESS, outbound only. Polls Postgres for sessions to run and
// streams events back to the synced event log.
const pool = createPool()
const db = createDb(pool)
const active = new Set<string>()

// eslint-disable-next-line no-console
console.log('[agent] daemon up (outbound only)')

async function loop(): Promise<void> {
  for (;;) {
    try {
      await pollAndRun(db, active)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[agent] poll error', err)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

void loop()
