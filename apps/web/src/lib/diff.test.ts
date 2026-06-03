import { describe, it, expect } from 'vitest'
import { computeDiff } from './diff.js'

describe('computeDiff', () => {
  it('marks a single changed line as 1 removal + 1 addition with surrounding context', () => {
    const d = computeDiff('a\nreturn null\nc', 'a\nreturn session\nc')
    expect(d.del).toBe(1)
    expect(d.add).toBe(1)
    expect(d.lines.find((l) => l.t === 'del')?.code).toBe('return null')
    expect(d.lines.find((l) => l.t === 'add')?.code).toBe('return session')
    expect(d.lines.filter((l) => l.t === 'ctx')).toHaveLength(2)
  })

  it('treats a new file as all additions', () => {
    const d = computeDiff('', 'x\ny')
    expect(d.del).toBe(0)
    expect(d.add).toBe(2)
    expect(d.lines.every((l) => l.t === 'add')).toBe(true)
  })

  it('reports no change as all context', () => {
    const d = computeDiff('same\nlines', 'same\nlines')
    expect(d.add).toBe(0)
    expect(d.del).toBe(0)
    expect(d.lines.every((l) => l.t === 'ctx')).toBe(true)
  })

  it('treats truncation to empty as all deletions', () => {
    const d = computeDiff('x\ny', '')
    expect(d.add).toBe(0)
    expect(d.del).toBe(2)
    expect(d.lines.every((l) => l.t === 'del')).toBe(true)
  })
})
