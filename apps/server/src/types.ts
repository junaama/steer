import 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    /** WorkOS subject (user id) set by the auth preHandler on protected routes. */
    userId: string
  }
}
