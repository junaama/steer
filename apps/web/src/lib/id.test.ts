import { describe, it, expect } from 'vitest'
import { randomId } from './id.js'

describe('randomId', () => {
  it('prefixes a uuid and is unique', () => {
    const a = randomId('sess')
    const b = randomId('sess')
    expect(a).toMatch(/^sess-[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})
