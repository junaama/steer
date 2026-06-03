import Fastify, { type FastifyInstance } from 'fastify'

/**
 * Build the Fastify instance. Kept as a factory so tests can drive it via
 * `app.inject(...)` without binding a port. Routes are added in later units
 * (U3: /writes + Electric proxy, U4: WorkOS auth).
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false })

  app.get('/health', async () => ({ status: 'ok' as const }))

  return app
}
