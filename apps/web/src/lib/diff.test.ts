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

  it('produces multiple hunks for changes separated by a long unchanged run', () => {
    // Change the first and last line; keep a long unchanged middle that the
    // context window collapses, yielding two distinct hunks.
    const before = ['top-old', ...Array.from({ length: 20 }, (_, i) => `mid-${i}`), 'bot-old'].join('\n')
    const after = ['top-new', ...Array.from({ length: 20 }, (_, i) => `mid-${i}`), 'bot-new'].join('\n')
    const d = computeDiff(before, after)

    expect(d.add).toBe(2)
    expect(d.del).toBe(2)
    // The collapsed middle means a later hunk starts after a gap.
    const hunkStarts = d.lines.filter((l) => l.hunkStart)
    expect(hunkStarts).toHaveLength(1)
    // The far-apart middle lines (e.g. mid-10) are dropped, not rendered.
    expect(d.lines.some((l) => l.code === 'mid-10')).toBe(false)
    // Both changes survive in their own hunks.
    expect(d.lines.some((l) => l.t === 'del' && l.code === 'top-old')).toBe(true)
    expect(d.lines.some((l) => l.t === 'add' && l.code === 'top-new')).toBe(true)
    expect(d.lines.some((l) => l.t === 'del' && l.code === 'bot-old')).toBe(true)
    expect(d.lines.some((l) => l.t === 'add' && l.code === 'bot-new')).toBe(true)
  })

  it('keeps a single hunk (no hunkStart) when changes are close together', () => {
    const d = computeDiff('a\nb\nold\nc\nd', 'a\nb\nnew\nc\nd')
    expect(d.lines.some((l) => l.hunkStart)).toBe(false)
    expect(d.add).toBe(1)
    expect(d.del).toBe(1)
  })

  it('numbers added lines by the new file and removed/context lines by the old file', () => {
    // Insert a line in the middle: the added line takes a new-file line number.
    const d = computeDiff('a\nb\nc', 'a\nb\nINSERT\nc')
    const added = d.lines.find((l) => l.t === 'add')!
    expect(added.code).toBe('INSERT')
    expect(added.n).toBe(3) // third line in the new file
    const ctxC = d.lines.filter((l) => l.t === 'ctx' && l.code === 'c')
    expect(ctxC).toHaveLength(1)
  })

  it('reports identical inputs as no changes (empty line list)', () => {
    const d = computeDiff('same\nlines\nhere', 'same\nlines\nhere')
    expect(d.add).toBe(0)
    expect(d.del).toBe(0)
    expect(d.lines).toHaveLength(0)
  })

  it('treats both inputs empty as an empty diff', () => {
    const d = computeDiff('', '')
    expect(d.add).toBe(0)
    expect(d.del).toBe(0)
    expect(d.lines).toHaveLength(0)
  })

  it('diffs a pure insertion at the end as additions only', () => {
    const d = computeDiff('a\nb', 'a\nb\nc\nd')
    expect(d.del).toBe(0)
    expect(d.add).toBe(2)
    expect(d.lines.filter((l) => l.t === 'add').map((l) => l.code)).toEqual(['c', 'd'])
  })
})
