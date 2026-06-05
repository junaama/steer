import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export interface MarkdownProps {
  /** Markdown source. May be partial/unterminated mid-stream — must not throw. */
  children: string
}

/**
 * Render a markdown string as a chat-style transcript body.
 *
 * Safety: raw HTML in the source is NOT executed. react-markdown ignores embedded
 * HTML unless `rehype-raw` is enabled — it is deliberately NOT enabled here — so an
 * `<img onerror=...>` or `<script>` in agent/user text renders as inert escaped
 * text, never as a live DOM node (the XSS guard the transcript depends on).
 *
 * Code: fenced blocks are highlighted by `rehype-highlight` (highlight.js). A block
 * tagged with a language (```ts) gets language-aware token markup; an untagged block
 * still renders as a plain <pre><code> code block. `detect: false` keeps untagged
 * blocks unhighlighted, and `ignoreMissing: true` makes an unknown language tag
 * degrade to a plain code block instead of throwing.
 *
 * Streaming: the underlying remark/rehype pipeline parses partial input (an
 * unterminated code fence, a half-written list) without throwing, so the live
 * stream from U4 can re-render this on every delta.
 */
export function Markdown({ children }: MarkdownProps): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
    >
      {children}
    </ReactMarkdown>
  )
}
