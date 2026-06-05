import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'

/**
 * Langfuse tracing for the REAL agent. Tracing is OFF unless explicitly enabled,
 * so the production daemon stays zero-overhead until you opt in by setting
 * Langfuse credentials (or STEER_TRACING=1). When on, the OTel spans the Vercel
 * AI SDK emits (via `experimental_telemetry` in model.ts) are exported to
 * Langfuse, so every model call in a session becomes an evaluable trace.
 *
 * External integration boundary (Langfuse/OTel) — excluded from coverage like
 * model.ts / mcp.ts and exercised via the eval runner.
 */
export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STEER_TRACING === '1' || (Boolean(env.LANGFUSE_PUBLIC_KEY) && Boolean(env.LANGFUSE_SECRET_KEY))
}

let processor: LangfuseSpanProcessor | undefined
let sdk: NodeSDK | undefined

/** Start the Langfuse OTel exporter once for this process. No-op when disabled. */
export function startTracing(env: NodeJS.ProcessEnv = process.env): boolean {
  if (sdk) return true
  if (!tracingEnabled(env)) return false
  processor = new LangfuseSpanProcessor()
  sdk = new NodeSDK({ spanProcessors: [processor] })
  sdk.start()
  return true
}

/** Flush buffered spans to Langfuse — call before a short-lived process exits. */
export async function flushTracing(): Promise<void> {
  await processor?.forceFlush()
}

/** Flush and stop the exporter. */
export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown()
  sdk = undefined
  processor = undefined
}
