import { useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { SessionStatus } from '@steer/schema'
import type { PlanItem, TraceItem, ToolItem, PendingQuestion } from '../lib/trace.js'
import { StatusPill } from './StatusPill.js'
import { ToolCard } from './ToolCard.js'
import { TodoPanel } from './TodoPanel.js'
import { Markdown } from './Markdown.js'
import { QuestionPrompt } from './QuestionPrompt.js'

const LIVE: SessionStatus[] = ['running', 'starting', 'awaiting-approval', 'awaiting-input']

const ROLE_LABEL: Record<'message' | 'thinking' | 'user', string> = {
  message: 'assistant',
  thinking: 'thinking',
  user: 'you',
}

/** Estimated row height (px) seeding the virtualizer before real measurement. */
const ESTIMATED_ROW_HEIGHT = 120
/** Rows rendered above/below the viewport so fast scrolls stay smooth. */
const OVERSCAN = 8

/** What the virtualizer reports for a row: its index and pixel offset. */
export interface WindowRow {
  index: number
  start: number
}

/**
 * Resolve which rows to render. Normally the virtualizer's windowed rows (only
 * those near the viewport). When it reports nothing for a non-empty trace — no
 * layout yet, or an environment without layout (jsdom) — fall back to rendering
 * every row at its estimated offset so the transcript is never blank. Pure so
 * the windowing decision is unit-tested without a DOM.
 */
export function resolveTraceRows(virtualRows: readonly WindowRow[], total: number): WindowRow[] {
  if (virtualRows.length > 0 || total === 0) {
    return [...virtualRows]
  }
  return Array.from({ length: total }, (_, index) => ({ index, start: index * ESTIMATED_ROW_HEIGHT }))
}

/**
 * One trace row. Pure given its item — a tool card or a message/thinking/user
 * bubble. Extracted so the virtualized list and tests render rows identically.
 * Streaming message/thinking items carry `streaming`, marked for a live caret.
 */
export function TraceRow({ item, controls }: { item: TraceItem; controls?: ReactNode }): JSX.Element {
  if (item.kind === 'tool') {
    return <ToolCard tool={item} controls={controls} />
  }
  return (
    <div className={`ev ev-${item.kind}`}>
      <div className="ev-role">{ROLE_LABEL[item.kind]}</div>
      <div className="ev-body" data-streaming={item.streaming ? true : undefined}>
        <Markdown>{item.text}</Markdown>
      </div>
    </div>
  )
}

export interface SessionDetailProps {
  title: string
  model: string
  status: SessionStatus
  /** The environment this session runs on; null/absent = unrouted (default daemon). */
  environment?: string | null
  items: TraceItem[]
  plan: PlanItem[] | null
  onInterrupt: () => void
  onContinue: () => void
  /** Send a follow-up message to the session (re-queues the agent). */
  onSendMessage?: (text: string) => Promise<void>
  /** The agent's pending `ask_user` question (R11); shown as a prominent answer prompt. */
  pendingQuestion?: PendingQuestion | null
  /** Answer the pending question (sends a user_message the parked agent resumes on). */
  onAnswer?: (text: string) => Promise<void>
  /** U11 injects per-tool interception controls; omitted here. */
  renderToolControls?: (tool: ToolItem) => ReactNode
}

export function SessionDetail(props: SessionDetailProps): JSX.Element {
  const live = LIVE.includes(props.status)
  const [composerText, setComposerText] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Virtualize the trace so a long transcript stays responsive: only the rows
  // near the viewport mount. `initialRect` seeds a usable window before layout
  // (and in jsdom, which has none), so rows still project from `estimateSize`.
  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN,
    initialRect: { width: 880, height: 600 },
  })

  const rows = resolveTraceRows(virtualizer.getVirtualItems(), props.items.length)
  // Spacer height: the virtualizer's measured total, or — in the render-all
  // fallback — the last row's estimated extent, so the scroll area is sized.
  const totalSize = Math.max(virtualizer.getTotalSize(), rows.length > 0 ? rows[rows.length - 1]!.start + ESTIMATED_ROW_HEIGHT : 0)

  const handleSend = async (): Promise<void> => {
    const trimmed = composerText.trim()
    if (!trimmed || !props.onSendMessage) return
    setSending(true)
    try {
      await props.onSendMessage(trimmed)
      setComposerText('')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="main">
      <header className="detail-head">
        <div className="dh-main">
          <h1>{props.title}</h1>
          <div className="dh-sub">
            <span>{props.model}</span>
            <span>·</span>
            <span>{props.items.length} events</span>
            {props.environment && (
              <>
                <span>·</span>
                <span className="env-badge" title={`Runs on environment ${props.environment}`}>
                  env: {props.environment}
                </span>
              </>
            )}
          </div>
        </div>
        <StatusPill status={props.status} />
        <div className="dh-actions">
          {props.status === 'interrupted' && (
            <button className="btn sm primary" onClick={props.onContinue}>
              Continue
            </button>
          )}
        </div>
      </header>

      <TodoPanel items={props.plan} />

      <div className="trace-wrap">
        <div className="trace" ref={scrollRef}>
          <div className="trace-inner">
            <div className="trace-virtual" style={{ height: totalSize, position: 'relative' }}>
              {rows.map((vrow) => {
                const item = props.items[vrow.index]!
                return (
                  <div
                    key={item.key}
                    className="trace-row"
                    data-index={vrow.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vrow.start}px)` }}
                  >
                    <TraceRow item={item} controls={item.kind === 'tool' ? props.renderToolControls?.(item) : undefined} />
                  </div>
                )
              })}
            </div>
            {live && props.items.length > 0 && (
              <div className="live-tail">
                <span className="ld" /> live — following
              </div>
            )}
          </div>
        </div>
        {props.pendingQuestion && props.onAnswer && (
          <QuestionPrompt question={props.pendingQuestion} onAnswer={props.onAnswer} />
        )}
        <div className="composer">
          <textarea
            className="composer-input"
            placeholder={live ? 'Interrupt the session first' : 'Send a follow-up instruction…'}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            disabled={live || sending}
          />
          <button
            className="btn primary sm"
            disabled={live || sending || !composerText.trim()}
            onClick={() => void handleSend()}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
          {live && (
            <button className="btn sm" onClick={props.onInterrupt}>
              Interrupt
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
