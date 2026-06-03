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
  if (provider === 'openai') {
    return env.OPENAI_MODEL ?? OPENAI_MODELS[tier] ?? 'gpt-4o-mini'
  }
  return env.ANTHROPIC_MODEL ?? ANTHROPIC_MODELS[tier] ?? 'claude-3-5-sonnet-latest'
}
