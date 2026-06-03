import { buildServer } from './app.js'
import { createPool, createDb } from './db.js'
import { createSessionVerifier } from './auth-session.js'

const pool = createPool()
const db = createDb(pool)
const electricUrl = process.env.ELECTRIC_URL ?? 'http://electric:3000'

// Self-hosted session auth — no external IdP, no auth-provider keys to
// configure. Tokens are minted at /auth/login|signup and verified against the
// auth_sessions table here.
const verifier = createSessionVerifier(db)

const app = buildServer({ db, verifier, electricUrl })
const port = Number(process.env.PORT ?? 8080)

app
  .listen({ port, host: '0.0.0.0' })
  .then((address) => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on ${address}`)
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[server] failed to start', err)
    process.exit(1)
  })
