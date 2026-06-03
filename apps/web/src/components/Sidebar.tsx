import { filterSessions, type SessionView, type FilterId } from '../lib/filter.js'
import { sessionStatusMeta, relTime } from '../lib/design.js'
import { Icon } from './Icon.js'

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Live' },
  { id: 'interrupted', label: 'Paused' },
  { id: 'completed', label: 'Done' },
  { id: 'error', label: 'Error' },
]

export interface SidebarProps {
  sessions: readonly SessionView[]
  activeId: string | null
  query: string
  filter: FilterId
  now: number
  onQuery: (q: string) => void
  onFilter: (f: FilterId) => void
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const visible = filterSessions(props.sessions, props.query, props.filter)
  return (
    <aside className="sidebar">
      <div className="side-head">
        <span className="eyebrow">Sessions</span>
        <div className="search">
          <Icon name="search" size={14} />
          <input
            value={props.query}
            placeholder="Search sessions…"
            aria-label="Search sessions"
            onChange={(e) => props.onQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="filters">
        {FILTERS.map((f) => (
          <button key={f.id} className="fchip" data-on={props.filter === f.id} onClick={() => props.onFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="session-list">
        {visible.length === 0 && (
          <div className="empty">{props.query ? 'No sessions match' : 'No sessions yet'}</div>
        )}
        {visible.map((s) => {
          const meta = sessionStatusMeta(s.lastStatus)
          return (
            <div
              key={s.id}
              className="srow"
              data-active={s.id === props.activeId}
              onClick={() => props.onOpen(s.id)}
            >
              <span className="s-dot" style={{ background: meta.color }} />
              <div className="s-main">
                <div className="s-title">{s.title}</div>
                <div className="s-meta">
                  <span style={{ color: meta.color }}>{meta.label}</span>
                  <span>·</span>
                  <span>{relTime(s.updatedAt, props.now)}</span>
                </div>
              </div>
              <button
                className="row-del"
                aria-label={`Delete ${s.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onDelete(s.id)
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="side-foot">
        <button className="btn primary block" onClick={props.onNew}>
          New session
        </button>
      </div>
    </aside>
  )
}
