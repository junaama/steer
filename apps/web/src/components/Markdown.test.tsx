import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from './Markdown.js'

describe('Markdown', () => {
  it('renders bold, lists, and a fenced code block as real elements (not literal markup)', () => {
    const source = ['**bold**', '', '- one', '- two', '', '```ts', 'const x = 1', '```'].join('\n')
    const { container } = render(<Markdown>{source}</Markdown>)

    // **bold** becomes a <strong>, not the literal asterisks.
    const strong = container.querySelector('strong')
    expect(strong?.textContent).toBe('bold')
    expect(screen.queryByText('**bold**')).not.toBeInTheDocument()

    // - list becomes <ul><li>…</li></ul>.
    const listItems = container.querySelectorAll('li')
    expect(listItems).toHaveLength(2)
    expect(listItems[0]?.textContent).toBe('one')
    expect(listItems[1]?.textContent).toBe('two')

    // The fenced block renders as a highlighted <pre><code> with the code text.
    const pre = container.querySelector('pre')
    const code = pre?.querySelector('code')
    expect(code?.textContent).toBe('const x = 1\n')
  })

  it('language-highlights a ```ts block and renders an untagged block as a plain code block', () => {
    const { container: tagged } = render(<Markdown>{'```ts\nconst x = 1\n```'}</Markdown>)
    const tsCode = tagged.querySelector('pre code')
    // rehype-highlight tags the language and emits highlight.js token <span>s.
    expect(tsCode?.className).toContain('language-ts')
    expect(tsCode?.className).toContain('hljs')
    expect(tsCode?.querySelectorAll('span.hljs-keyword').length).toBeGreaterThan(0)

    const { container: untagged } = render(<Markdown>{'```\nplain code\n```'}</Markdown>)
    const plainCode = untagged.querySelector('pre code')
    // An untagged fence is still a <pre><code> block, but gets no language class
    // and no highlight tokens (detect: false leaves it unhighlighted).
    expect(plainCode).not.toBeNull()
    expect(plainCode?.textContent).toBe('plain code\n')
    expect(plainCode?.className).not.toContain('language-')
    expect(plainCode?.querySelector('span.hljs-keyword')).toBeNull()
  })

  it('does not render raw HTML in the source as live HTML (XSS guard)', () => {
    const { container } = render(
      <Markdown>{'before <img src=x onerror="alert(1)"> <script>alert(2)</script> after'}</Markdown>,
    )
    // No live <img> or <script> node is injected; the raw HTML is inert text.
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    // The surrounding prose still renders.
    expect(container.textContent).toContain('before')
    expect(container.textContent).toContain('after')
  })

  it('renders a partial mid-stream string with an unterminated code fence without throwing', () => {
    expect(() => render(<Markdown>{'Here is some code:\n```ts\nconst x ='}</Markdown>)).not.toThrow()
    // The half-written fence still projects to a code block holding the partial text.
    const { container } = render(<Markdown>{'```ts\nconst x ='}</Markdown>)
    expect(container.querySelector('pre code')?.textContent).toContain('const x =')
  })
})
