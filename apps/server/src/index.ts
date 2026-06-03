import { buildServer } from './app.js'

const app = buildServer()
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
