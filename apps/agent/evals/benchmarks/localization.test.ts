import { describe, it, expect } from 'vitest'
import { localizationF1 } from './localization.js'

describe('localizationF1', () => {
  it('returns F1=1 for an exact match', () => {
    const r = localizationF1(['requests/models.py'], ['requests/models.py'])
    expect(r.value).toBe(1)
    expect(r.name).toBe('localization_f1')
  })

  it('returns F1=0 for completely disjoint sets', () => {
    const r = localizationF1(['requests/models.py'], ['requests/sessions.py'])
    expect(r.value).toBe(0)
  })

  it('returns F1=0 when there are no edits', () => {
    const r = localizationF1([], ['requests/models.py'])
    expect(r.value).toBe(0)
    expect(r.comment).toContain('no edits')
  })

  it('returns F1=0 with no-edits comment when edited set is empty and gold is also empty', () => {
    const r = localizationF1([], [])
    expect(r.value).toBe(0)
    expect(r.comment).toContain('no edits')
  })

  it('returns F1=0 with a note when there are no gold files (Terminal-bench)', () => {
    const r = localizationF1(['some_file.py'], [])
    expect(r.value).toBe(0)
    expect(r.comment).toContain('no gold files')
  })

  it('computes partial overlap: 1 hit out of 2 edited, 1 gold → precision=0.5 recall=1', () => {
    // edited=[A,B] gold=[A] → hits=1, precision=0.5, recall=1, F1=0.667
    const r = localizationF1(['requests/models.py', 'requests/utils.py'], ['requests/models.py'])
    const expected = (2 * 0.5 * 1) / (0.5 + 1)
    expect(r.value).toBeCloseTo(expected, 5)
  })

  it('computes partial overlap: 1 hit, edited=1, gold=2 → precision=1 recall=0.5', () => {
    // edited=[A] gold=[A,B] → hits=1, precision=1, recall=0.5, F1=0.667
    const r = localizationF1(['requests/models.py'], ['requests/models.py', 'requests/sessions.py'])
    const expected = (2 * 1 * 0.5) / (1 + 0.5)
    expect(r.value).toBeCloseTo(expected, 5)
  })

  it('handles multiple files all matching (exact multi-file match → F1=1)', () => {
    const files = ['src/flask/blueprints.py', 'src/flask/app.py']
    const r = localizationF1(files, files)
    expect(r.value).toBe(1)
  })

  it('includes the edited and gold file lists in the comment', () => {
    const r = localizationF1(['a.py'], ['a.py'])
    expect(r.comment).toContain('edited=[a.py]')
    expect(r.comment).toContain('gold=[a.py]')
  })
})
