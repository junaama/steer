import { Fragment, type ReactNode } from 'react'
import type { ToolItem, TraceItem } from '../lib/trace.js'
import { computeDiff } from '../lib/diff.js'
import { StatBadge } from './StatBadge.js'
import { DiffView } from './DiffView.js'

function argSummary(args: Record<string, unknown>): string {
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  const first = String(args[keys[0]!])
  return keys.length > 1 ? `${first}  · +${keys.length - 1}` : first
}

const ROLE_LABEL: Record<'message' | 'thinking' | 'user', string> = {
  message: 'assistant',
  thinking: 'thinking',
  user: 'you',
}

const EXIT_MARKER_RE = /\n?(\[exit \d+\])$/

function ResultBlock({ toolName, result }: { toolName: string; result: string }): JSX.Element {
  if (toolName !== 'run_command') return <div className="result-block">{result}</div>

  const match = result.match(EXIT_MARKER_RE)
  const output = match ? result.slice(0, match.index) : result
  const exitMarker = match?.[1]
  return (
    <pre className="result-block result-terminal" data-testid="run-command-result">
      <code>
        <span>{output}</span>
        {exitMarker && <span className="terminal-exit">{exitMarker}</span>}
      </code>
    </pre>
  )
}

function TraceChild({ item }: { item: TraceItem }): JSX.Element {
  if (item.kind === 'tool') return <ToolCard tool={item} />
  return (
    <div className={`ev ev-${item.kind}`}>
      <div className="ev-role">{ROLE_LABEL[item.kind]}</div>
      <div className="ev-body">{item.text}</div>
    </div>
  )
}

export function ToolCard({ tool, controls }: { tool: ToolItem; controls?: ReactNode }): JSX.Element {
  return (
    <div className="toolcard" data-attn={tool.status === 'pending'} data-testid={`tool-${tool.toolCallId}`}>
      <div className="tc-head">
        <span className="tc-name">{tool.name}</span>
        <span className="tc-kind" data-k={tool.toolKind}>
          {tool.toolKind === 'side-effecting' ? 'side-effect' : 'read-only'}
        </span>
        <span className="tc-args-inline">{argSummary(tool.args)}</span>
        <StatBadge status={tool.status} />
      </div>

      {tool.substitutedFrom && (
        <div className="audit">
          operator substituted <span className="from">{tool.substitutedFrom}</span> →{' '}
          <span className="to">{tool.name}</span>
        </div>
      )}

      {tool.editedArgs && <div className="audit">operator edited arguments before running</div>}

      <div className="tc-body">
        <div className="tc-section">
          <div className="tc-label">Arguments</div>
          <div className="kv">
            {Object.entries(tool.args).map(([k, v]) => (
              <Fragment key={k}>
                <span className="k">{k}</span>
                <span className="v">{String(v)}</span>
              </Fragment>
            ))}
          </div>
        </div>
        {tool.after !== undefined && (
          <div className="tc-section">
            <div className="tc-label">Proposed change</div>
            <DiffView file={String(tool.args.path ?? 'file')} diff={computeDiff(tool.before ?? '', tool.after)} />
          </div>
        )}
        {tool.result !== null && (
          <div className="tc-section">
            <div className="tc-label">{tool.after !== undefined ? 'Outcome' : 'Result'}</div>
            <ResultBlock toolName={tool.name} result={tool.result} />
          </div>
        )}
      </div>

      {tool.children && tool.children.length > 0 && (
        <div className="subpanel" data-testid={`tool-${tool.toolCallId}-children`}>
          <div className="sp-head">
            <span>Subagent</span>
          </div>
          <div className="argeditor">
            {tool.children.map((item) => (
              <TraceChild key={item.key} item={item} />
            ))}
          </div>
        </div>
      )}

      {controls}
    </div>
  )
}
