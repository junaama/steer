import { describe, it, expect } from 'vitest'
import { resolveProvider, resolveModelId, providerSupportsVision } from './provider.js'

describe('resolveProvider', () => {
  it('honors an explicit LLM_PROVIDER', () => {
    expect(resolveProvider({ LLM_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'x' })).toBe('openai')
    expect(resolveProvider({ LLM_PROVIDER: 'ANTHROPIC', OPENAI_API_KEY: 'x' })).toBe('anthropic')
  })

  it('auto-detects from the configured key (OpenAI preferred when both set)', () => {
    expect(resolveProvider({ OPENAI_API_KEY: 'x' })).toBe('openai')
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'x' })).toBe('anthropic')
    expect(resolveProvider({ OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' })).toBe('openai')
  })

  it('falls back to anthropic when nothing is set', () => {
    expect(resolveProvider({})).toBe('anthropic')
    expect(resolveProvider({ LLM_PROVIDER: 'bogus' })).toBe('anthropic')
  })
})

describe('resolveModelId', () => {
  it('maps UI tiers to provider models', () => {
    expect(resolveModelId('openai', 'haiku')).toBe('gpt-4o-mini')
    expect(resolveModelId('openai', 'sonnet')).toBe('gpt-4o')
    expect(resolveModelId('anthropic', 'opus')).toBe('claude-3-opus-latest')
  })

  it('falls back for an unknown tier', () => {
    expect(resolveModelId('openai', 'mystery')).toBe('gpt-4o-mini')
    expect(resolveModelId('anthropic', 'mystery')).toBe('claude-3-5-sonnet-latest')
  })

  it('honors an explicit model override', () => {
    expect(resolveModelId('openai', 'haiku', { OPENAI_MODEL: 'gpt-4.1' })).toBe('gpt-4.1')
    expect(resolveModelId('anthropic', 'sonnet', { ANTHROPIC_MODEL: 'claude-x' })).toBe('claude-x')
  })

  it('treats an empty-string override as unset (docker-compose injects "" for unset vars)', () => {
    // Regression: `${OPENAI_MODEL:-}` becomes "" in the container; an empty model id
    // made the SDK throw "you must provide a model parameter" and every session errored.
    expect(resolveModelId('openai', 'sonnet', { OPENAI_MODEL: '' })).toBe('gpt-4o')
    expect(resolveModelId('anthropic', 'opus', { ANTHROPIC_MODEL: '' })).toBe('claude-3-opus-latest')
  })
})

describe('providerSupportsVision (R14)', () => {
  it('recognizes the OpenAI vision-capable model families', () => {
    expect(providerSupportsVision('openai', 'gpt-4o')).toBe(true)
    expect(providerSupportsVision('openai', 'gpt-4o-mini')).toBe(true)
    expect(providerSupportsVision('openai', 'gpt-4-turbo')).toBe(true)
    expect(providerSupportsVision('openai', 'gpt-4.1')).toBe(true)
    expect(providerSupportsVision('openai', 'o1-preview')).toBe(true)
  })

  it('recognizes Anthropic claude-3 and later as vision-capable', () => {
    expect(providerSupportsVision('anthropic', 'claude-3-5-sonnet-latest')).toBe(true)
    expect(providerSupportsVision('anthropic', 'claude-3-opus-latest')).toBe(true)
    expect(providerSupportsVision('anthropic', 'claude-3-5-haiku-latest')).toBe(true)
  })

  it('matches the model id case-insensitively (an override may be upper-cased)', () => {
    expect(providerSupportsVision('openai', 'GPT-4O')).toBe(true)
    expect(providerSupportsVision('anthropic', 'Claude-3-5-Sonnet')).toBe(true)
  })

  it('treats explicit text-only model families as non-vision', () => {
    expect(providerSupportsVision('openai', 'gpt-3.5-turbo')).toBe(false)
    expect(providerSupportsVision('anthropic', 'claude-2.1')).toBe(false)
    expect(providerSupportsVision('anthropic', 'claude-instant-1.2')).toBe(false)
  })

  it('treats an unknown/custom model id as non-vision (conservative default)', () => {
    expect(providerSupportsVision('openai', 'some-custom-text-model')).toBe(false)
    expect(providerSupportsVision('anthropic', 'claude-x')).toBe(false)
    expect(providerSupportsVision('anthropic', 'mistral-large')).toBe(false)
  })
})
