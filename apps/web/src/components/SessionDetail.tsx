import type { ReactNode } from 'react'
import type { SessionStatus } from '@steer/schema'
import type { TraceItem, ToolItem } from '../lib/trace.js'
import { StatusPill } from './StatusPill.js'
import { ToolCard } from './ToolCard.js'

const LIVE: SessionStatus[] = ['running', 'starting', 'awaiting-approval']

export interface SessionDetailProps {
  title: string
  model: string
  status: SessionStatus
  items: TraceItem[]
  onInterrupt: () => void
  onContinue: () => void
  /** U11 injects per-tool interception controls; omitted here. */
  renderToolControls?: (tool: ToolItem) => ReactNode
}

export function SessionDetail(props: SessionDetailProps): JSX.Element {
  const live = LIVE.includes(props.status)
  return (
    <section className="main">
      <header className="detail-head">
        <div className="dh-main">
          <h1>{props.title}</h1>
          <div className="dh-sub">
            <span>{props.model}</span>
            <span>·</span>
            <span>{props.items.length} events</span>
          </div>
        </div>
        <StatusPill status={props.status} />
        <div className="dh-actions">
          {live && (
            <button className="btn sm" onClick={props.onInterrupt}>
              Interrupt
            </button>
          )}
          {props.status === 'interrupted' && (
            <button className="btn sm primary" onClick={props.onContinue}>
              Continue
            </button>
          )}
        </div>
      </header>

      <div className="trace-wrap">
        <div className="trace">
          <div className="trace-inner">
            {props.items.map((item) =>
              item.kind === 'tool' ? (
                <div className="ev" key={item.key}>
                  <ToolCard tool={item} controls={props.renderToolControls?.(item)} />
                </div>
              ) : (
                <div className={`ev ev-${item.kind}`} key={item.key}>
                  <div className="ev-role">{item.kind === 'thinking' ? 'thinking' : 'assistant'}</div>
                  <div className="ev-body">{item.text}</div>
                </div>
              ),
            )}
            {live && props.items.length > 0 && (
              <div className="live-tail">
                <span className="ld" /> live — following
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
