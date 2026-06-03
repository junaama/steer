import { Fragment, type ReactNode } from 'react'
import type { ToolItem } from '../lib/trace.js'
import { StatBadge } from './StatBadge.js'

function argSummary(args: Record<string, unknown>): string {
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  const first = String(args[keys[0]!])
  return keys.length > 1 ? `${first}  · +${keys.length - 1}` : first
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
        {tool.result !== null && (
          <div className="tc-section">
            <div className="tc-label">Result</div>
            <div className="result-block">{tool.result}</div>
          </div>
        )}
      </div>

      {controls}
    </div>
  )
}
