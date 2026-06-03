import 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated subject (the `users.id`) set by the auth preHandler on protected routes. */
    userId: string
  }
}
