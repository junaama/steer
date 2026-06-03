import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db.js'
import { registerCors } from './cors.js'
import { registerAuth, type AuthVerifier } from './auth.js'
import { registerAuthRoutes } from './auth-routes.js'
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

  // CORS first: a preflight (OPTIONS, sent without the bearer token) must
  // short-circuit before the auth gate below, or the browser's preflight 401s.
  registerCors(app)

  app.get('/health', async () => ({ status: 'ok' as const }))

  registerAuth(app, opts.verifier, {
    protect: (url) =>
      url.startsWith('/writes') || url.startsWith('/sync') || url.startsWith('/auth/me'),
  })
  registerAuthRoutes(app, opts.db)
  registerWrites(app, opts.db)
  registerProxy(app, { db: opts.db, electricUrl: opts.electricUrl, fetchImpl: opts.fetchImpl })

  return app
}
