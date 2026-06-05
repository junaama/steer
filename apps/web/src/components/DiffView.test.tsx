import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { DiffView, languageForFile } from './DiffView.js'
import { computeDiff } from '../lib/diff.js'

describe('DiffView', () => {
  it('renders context, added and removed lines with the file header', () => {
    render(<DiffView file="src/x.ts" diff={computeDiff('a\nold\nc', 'a\nnew\nc')} />)
    expect(screen.getByText('src/x.ts')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    // each line's full code text survives highlighting
    const codeText = screen.getAllByTestId('diff') // sanity: the diff mounted
    expect(codeText).toHaveLength(1)
    const lines = screen.getByTestId('diff').querySelectorAll('.code')
    const texts = Array.from(lines).map((el) => el.textContent)
    expect(texts).toContain('old')
    expect(texts).toContain('new')
    expect(texts).toContain('a')
  })

  it('marks added lines with + and removed lines with − signs', () => {
    render(<DiffView file="src/x.ts" diff={computeDiff('keep\nold', 'keep\nnew')} />)
    const diff = screen.getByTestId('diff')
    const addLine = diff.querySelector('.diff-line[data-t="add"]')!
    const delLine = diff.querySelector('.diff-line[data-t="del"]')!
    expect(addLine.querySelector('.sign')?.textContent).toBe('+')
    expect(delLine.querySelector('.sign')?.textContent).toBe('−')
    const ctxLine = diff.querySelector('.diff-line[data-t="ctx"]')!
    expect(ctxLine.querySelector('.sign')?.textContent).toBe('')
  })

  it('applies language-aware syntax highlighting to code lines', () => {
    // `return` is a TS keyword → highlight.js wraps it in an hljs-keyword span.
    render(<DiffView file="auth.ts" diff={computeDiff('return null', 'return session')} />)
    const diff = screen.getByTestId('diff')
    const keyword = diff.querySelector('.hljs-keyword')
    expect(keyword).not.toBeNull()
    expect(keyword?.textContent).toBe('return')
    // the code container advertises the resolved language
    const code = diff.querySelector('.code')!
    expect(code.getAttribute('data-lang')).toBe('typescript')
  })

  it('falls back to auto-detection for an unknown/extensionless file', () => {
    render(<DiffView file="Makefile" diff={computeDiff('x', 'y')} />)
    const code = screen.getByTestId('diff').querySelector('.code')!
    expect(code.getAttribute('data-lang')).toBe('auto')
  })

  it('renders every hunk of a multi-hunk diff with a separator between them', () => {
    const before = ['top-old', ...Array.from({ length: 20 }, (_, i) => `mid-${i}`), 'bot-old'].join('\n')
    const after = ['top-new', ...Array.from({ length: 20 }, (_, i) => `mid-${i}`), 'bot-new'].join('\n')
    render(<DiffView file="src/x.ts" diff={computeDiff(before, after)} />)
    const diff = screen.getByTestId('diff')
    const codeTexts = Array.from(diff.querySelectorAll('.code')).map((el) => el.textContent)
    // both hunks rendered
    expect(codeTexts).toContain('top-old')
    expect(codeTexts).toContain('top-new')
    expect(codeTexts).toContain('bot-old')
    expect(codeTexts).toContain('bot-new')
    // exactly one hunk separator marker (the second hunk's first line)
    expect(diff.querySelectorAll('.diff-line[data-hunk-start="true"]')).toHaveLength(1)
  })

  it('renders an empty state for a no-op diff (before === after)', () => {
    render(<DiffView file="src/x.ts" diff={computeDiff('same\nlines', 'same\nlines')} />)
    const diff = screen.getByTestId('diff')
    expect(within(diff).getByTestId('diff-empty')).toHaveTextContent('No changes')
    // header still renders +0/−0 without throwing
    expect(within(diff).getByText('+0')).toBeInTheDocument()
    expect(diff.querySelectorAll('.diff-line')).toHaveLength(0)
  })

  it('renders a blank code line (empty string) without throwing', () => {
    // deleting content that includes a blank line
    render(<DiffView file="src/x.ts" diff={computeDiff('keep\n\nold', 'keep')} />)
    expect(screen.getByTestId('diff')).toBeInTheDocument()
  })
})

describe('languageForFile', () => {
  it('maps common extensions to highlight.js languages', () => {
    expect(languageForFile('a.ts')).toBe('typescript')
    expect(languageForFile('a.tsx')).toBe('typescript')
    expect(languageForFile('a.js')).toBe('javascript')
    expect(languageForFile('a.py')).toBe('python')
    expect(languageForFile('a.go')).toBe('go')
    expect(languageForFile('a.css')).toBe('css')
    expect(languageForFile('a.json')).toBe('json')
  })

  it('is case-insensitive on the extension', () => {
    expect(languageForFile('A.TS')).toBe('typescript')
  })

  it('returns undefined for an unknown extension', () => {
    expect(languageForFile('a.zzz')).toBeUndefined()
  })

  it('returns undefined for an extensionless path', () => {
    expect(languageForFile('Dockerfile')).toBeUndefined()
  })
})
