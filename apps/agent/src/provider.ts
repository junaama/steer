export type Provider = 'anthropic' | 'openai'

/** UI model tier → provider-specific model id. */
const ANTHROPIC_MODELS: Record<string, string> = {
  sonnet: 'claude-3-5-sonnet-latest',
  opus: 'claude-3-opus-latest',
  haiku: 'claude-3-5-haiku-latest',
}
const OPENAI_MODELS: Record<string, string> = {
  sonnet: 'gpt-4o',
  opus: 'gpt-4o',
  haiku: 'gpt-4o-mini',
}

export interface ProviderEnv {
  LLM_PROVIDER?: string
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
}

/**
 * Choose the LLM provider: an explicit LLM_PROVIDER wins; otherwise auto-detect
 * from whichever API key is configured (OpenAI preferred when both are set);
 * Anthropic is the final fallback.
 */
export function resolveProvider(env: ProviderEnv): Provider {
  const explicit = env.LLM_PROVIDER?.toLowerCase()
  if (explicit === 'openai' || explicit === 'anthropic') return explicit
  if (env.OPENAI_API_KEY) return 'openai'
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  return 'anthropic'
}

/**
 * Resolve the concrete model id for a provider + UI tier. An explicit
 * OPENAI_MODEL / ANTHROPIC_MODEL override wins.
 */
export function resolveModelId(
  provider: Provider,
  tier: string,
  env: { OPENAI_MODEL?: string; ANTHROPIC_MODEL?: string } = {},
): string {
  // `||` (not `??`): docker-compose injects `OPENAI_MODEL: ${OPENAI_MODEL:-}` as an
  // EMPTY STRING when unset, and an empty model id makes the SDK throw. Treat "" as absent.
  if (provider === 'openai') {
    return env.OPENAI_MODEL || OPENAI_MODELS[tier] || 'gpt-4o-mini'
  }
  return env.ANTHROPIC_MODEL || ANTHROPIC_MODELS[tier] || 'claude-3-5-sonnet-latest'
}

// Substrings of model ids known NOT to accept image input, checked first so a
// non-vision model is never sent an image part (which the SDK would reject). Kept
// as a conservative denylist of the text-only models Steer can resolve: OpenAI's
// gpt-3.5 family and Anthropic's legacy claude-2 / instant generations.
const NON_VISION_MODEL_MARKERS = ['gpt-3.5', 'claude-2', 'claude-instant'] as const

/**
 * Feature-detect whether the resolved provider/model can read an attached image
 * (R14, vision input). Conservative by design: an UNKNOWN/custom model id (set via
 * OPENAI_MODEL / ANTHROPIC_MODEL) is treated as NON-vision so the agent degrades to
 * "image omitted" rather than sending an image part a text-only model would reject.
 *
 * Vision is recognized for the model families Steer resolves that accept images:
 * OpenAI's gpt-4o / gpt-4-turbo / gpt-4.1 / o1 lines and Anthropic's claude-3+
 * (3, 3.5, and later) — minus the explicit text-only markers above. The model id
 * is matched case-insensitively so an override like `GPT-4O` still detects.
 */
export function providerSupportsVision(provider: Provider, modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (NON_VISION_MODEL_MARKERS.some((marker) => id.includes(marker))) return false
  if (provider === 'openai') {
    return ['gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'o1', 'o3', 'o4'].some((m) => id.includes(m))
  }
  // Anthropic: every claude-3 and later generation is vision-capable.
  return /claude-(?:3|[4-9])/.test(id)
}
