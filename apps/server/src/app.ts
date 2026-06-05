import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db.js'
import { registerCors } from './cors.js'
import { registerAuth, type AuthVerifier } from './auth.js'
import { registerAuthRoutes } from './auth-routes.js'
import { registerMessages } from './messages.js'
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
  // Raise the request body limit above Fastify's 1 MiB default so a session-create
  // carrying an at-cap attached image (R14: base64 image up to MAX_IMAGE_BASE64_BYTES,
  // ~1.5 MB, plus JSON envelope overhead) reaches the write handler and is rejected
  // by the SCHEMA size cap with a clear 400 — not silently dropped as a 413 by the
  // transport. Kept tight (2 MiB) so the boundary still bounds the payload.
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })

  // CORS first: a preflight (OPTIONS, sent without the bearer token) must
  // short-circuit before the auth gate below, or the browser's preflight 401s.
  registerCors(app)

  app.get('/health', async () => ({ status: 'ok' as const }))

  registerAuth(app, opts.verifier, {
    protect: (url) =>
      url.startsWith('/writes') ||
      url.startsWith('/sync') ||
      url.startsWith('/auth/me') ||
      url.startsWith('/sessions/'),
  })
  registerAuthRoutes(app, opts.db)
  registerMessages(app, opts.db)
  registerWrites(app, opts.db)
  registerProxy(app, { db: opts.db, electricUrl: opts.electricUrl, fetchImpl: opts.fetchImpl })

  return app
}
