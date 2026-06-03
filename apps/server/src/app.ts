import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db.js'
import { registerAuth, type AuthVerifier } from './auth.js'
import { registerWrites } from './writes.js'
import { registerProxy, type FetchImpl } from './proxy.js'
import './types.js'

export interface ServerOptions {
  db: Db
  verifier: AuthVerifier
  electricUrl: string
  fetchImpl?: FetchImpl
}

/**
 * Build the Fastify instance with injected dependencies (db, auth verifier,
 * Electric URL). Dependency injection keeps it driveable via `app.inject(...)`
 * in tests with a fake verifier and a fake Electric upstream.
 */
export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false })

  app.get('/health', async () => ({ status: 'ok' as const }))

  registerAuth(app, opts.verifier, {
    protect: (url) => url.startsWith('/writes') || url.startsWith('/sync'),
  })
  registerWrites(app, opts.db)
  registerProxy(app, { db: opts.db, electricUrl: opts.electricUrl, fetchImpl: opts.fetchImpl })

  return app
}
