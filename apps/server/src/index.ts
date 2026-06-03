import { buildServer } from './app.js'
import { createPool, createDb } from './db.js'
import { createPlaceholderVerifier } from './auth.js'
import { createWorkosVerifier } from './auth-workos.js'

const pool = createPool()
const db = createDb(pool)
const electricUrl = process.env.ELECTRIC_URL ?? 'http://electric:3000'

const clientId = process.env.WORKOS_CLIENT_ID
const verifier = clientId
  ? createWorkosVerifier({ clientId })
  : // No WORKOS_CLIENT_ID configured: boot, but reject protected routes (401).
    createPlaceholderVerifier()

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
