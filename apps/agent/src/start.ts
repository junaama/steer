import { ShapeStream } from '@electric-sql/client'
import { hostname } from 'node:os'
import { createPool, createDb } from './db.js'
import { createRunner } from './daemon.js'
import { subscribeRunnable } from './intake.js'

export interface DaemonOptions {
  /** Routing identity: null = the default daemon (runs unrouted sessions). */
  env: string | null
  electricUrl?: string
}

/**
 * Boot the portless agent daemon: subscribe to the sessions shape (PRD 4.d) for
 * this environment, claim + run each routed session, and append events directly
 * to Postgres (PRD 4.e). Returns the stream unsubscribe fn. Outbound only — it
 * opens no inbound port.
 */
export function startDaemon(opts: DaemonOptions): () => void {
  const pool = createPool()
  const db = createDb(pool)
  const electricUrl = opts.electricUrl ?? process.env.ELECTRIC_URL ?? 'http://electric:3000'
  // The claim owner must be STABLE so a follow-up turn / crash-resume re-claims
  // the same session: the env id when set, else the hostname for the default daemon.
  const owner = opts.env ?? hostname()
  const active = new Set<string>()
  const run = createRunner(db, active, owner)
  const stream = new ShapeStream({
    url: `${electricUrl}/v1/shape`,
    params: { table: 'sessions' },
  })
  // eslint-disable-next-line no-console
  console.log(`[agent] daemon up (outbound only) — env=${opts.env ?? 'default'}, owner=${owner}`)
  return subscribeRunnable(stream, run, opts.env, (err) => {
    // eslint-disable-next-line no-console
    console.error('[agent] sync error', err)
  })
}
