// Agent daemon entrypoint. PORTLESS by design — connects outbound only.
// Populated in U5: subscribe to sessions + controls via Electric, run the
// Vercel AI SDK loop, append event rows through the server's write API, halt
// on interrupt control rows, and resume from MAX(seq) on restart.

const serverUrl = process.env.SERVER_URL ?? 'http://server:8080'

// eslint-disable-next-line no-console
console.log(`[agent] daemon up (outbound only) — will reach ${serverUrl}; loop arrives in U5`)

// Keep the process resident so the container stays alive.
setInterval(() => {}, 1 << 30)
