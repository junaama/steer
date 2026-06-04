import { describe, it, expect } from 'vitest'
import { resolveEnvironmentId } from './environment.js'

describe('resolveEnvironmentId', () => {
  it('returns the trimmed value when a non-empty environment is set', () => {
    expect(resolveEnvironmentId('laptop')).toBe('laptop')
    expect(resolveEnvironmentId('  laptop  ')).toBe('laptop')
  })

  it('returns null (the default / unrouted daemon) for empty or missing input', () => {
    expect(resolveEnvironmentId(undefined)).toBeNull()
    expect(resolveEnvironmentId(null)).toBeNull()
    expect(resolveEnvironmentId('')).toBeNull()
    expect(resolveEnvironmentId('   ')).toBeNull()
  })
})
