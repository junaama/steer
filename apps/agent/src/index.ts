import { ShapeStream } from '@electric-sql/client'
import { createPool, createDb } from './db.js'
import { createRunner } from './daemon.js'
import { subscribeRunnable } from './intake.js'

// Agent daemon — PORTLESS, outbound only. Sessions to run arrive via an Electric
// SQL shape subscription (PRD 4.d — the same sync read path the UI uses); events
// are streamed back by appending directly to the database (PRD 4.e).
const pool = createPool()
const db = createDb(pool)
const electricUrl = process.env.ELECTRIC_URL ?? 'http://electric:3000'
const active = new Set<string>()
const run = createRunner(db, active)

// Subscribe to the full sessions shape and let the runner filter to
// starting/running rows; the long-poll keeps this process alive with no port.
const stream = new ShapeStream({
  url: `${electricUrl}/v1/shape`,
  params: { table: 'sessions' },
})

// eslint-disable-next-line no-console
console.log('[agent] daemon up (outbound only) — sessions via Electric sync')

subscribeRunnable(stream, run, (err) => {
  // eslint-disable-next-line no-console
  console.error('[agent] sync error', err)
})
