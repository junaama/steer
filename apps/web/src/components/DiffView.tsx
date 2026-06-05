import hljs from 'highlight.js'
import type { FileDiff } from '../lib/diff.js'

/**
 * Map a file path to a highlight.js language id. Returns undefined for an
 * unknown/extensionless path so the caller renders that line as plain text
 * (highlight.js would otherwise throw on an unregistered language).
 */
export function languageForFile(file: string): string | undefined {
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1).toLowerCase() : ''
  const byExt: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    css: 'css',
    html: 'xml',
    md: 'markdown',
    py: 'python',
    go: 'go',
    rs: 'rust',
    sh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    sql: 'sql',
  }
  const lang = byExt[ext]
  return lang && hljs.getLanguage(lang) ? lang : undefined
}

/**
 * Syntax-highlight one line of code, returning highlight.js token markup as an
 * HTML string. highlight.js HTML-escapes the source, so the result is safe to
 * inject — the only nodes it creates are `<span class="hljs-…">` wrappers around
 * the (escaped) code. An empty line yields an empty string so a blank diff line
 * still renders. Falls back to plain escaped text when the language is unknown.
 */
function highlightLine(code: string, language: string | undefined): string {
  if (code.length === 0) return ''
  if (language) return hljs.highlight(code, { language, ignoreIllegals: true }).value
  return hljs.highlightAuto(code).value
}

export function DiffView({ file, diff }: { file: string; diff: FileDiff }): JSX.Element {
  const language = languageForFile(file)

  return (
    <div className="diff" data-testid="diff">
      <div className="diff-file">
        <span>{file}</span>
        <span style={{ marginLeft: 'auto' }} className="add">
          +{diff.add}
        </span>
        <span className="del">−{diff.del}</span>
      </div>
      {diff.lines.length === 0 ? (
        <div className="diff-empty" data-testid="diff-empty">
          No changes
        </div>
      ) : (
        <div>
          {diff.lines.map((l, i) => (
            <div className="diff-line" data-t={l.t} data-hunk-start={l.hunkStart ? true : undefined} key={i}>
              <span className="gut">{l.n}</span>
              <span className="sign">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
              <span
                className="code hljs"
                data-lang={language ?? 'auto'}
                dangerouslySetInnerHTML={{ __html: highlightLine(l.code, language) }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
