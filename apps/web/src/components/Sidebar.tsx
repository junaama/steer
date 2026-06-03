import { useEffect, useRef, useState } from 'react'
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
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const visible = filterSessions(props.sessions, props.query, props.filter)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // ⌘K / Ctrl+K jumps focus to the search box (matches the prototype shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const commit = (): void => {
    if (editing) {
      const title = editing.value.trim()
      const current = props.sessions.find((s) => s.id === editing.id)
      if (title && current && title !== current.title) props.onRename(editing.id, title)
    }
    setEditing(null)
  }

  return (
    <aside className="sidebar">
      <div className="side-head">
        <span className="eyebrow">Sessions</span>
        <div className="search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            value={props.query}
            placeholder="Search sessions…"
            aria-label="Search sessions"
            onChange={(e) => props.onQuery(e.target.value)}
          />
          <kbd>⌘K</kbd>
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
          const isEditing = editing?.id === s.id
          return (
            <div
              key={s.id}
              className="srow"
              data-active={s.id === props.activeId}
              onClick={() => {
                if (!isEditing) props.onOpen(s.id)
              }}
            >
              <span className="s-dot" style={{ background: meta.color }} />
              <div className="s-main">
                {isEditing ? (
                  <input
                    className="s-rename"
                    autoFocus
                    aria-label={`New name for ${s.title}`}
                    value={editing.value}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditing({ id: s.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commit()
                      else if (e.key === 'Escape') setEditing(null)
                    }}
                    onBlur={commit}
                  />
                ) : (
                  <div className="s-title" title={s.title}>
                    {s.title}
                  </div>
                )}
                <div className="s-meta">
                  <span style={{ color: meta.color }}>{meta.label}</span>
                  <span>·</span>
                  <span>{relTime(s.updatedAt, props.now)}</span>
                </div>
              </div>
              <button
                className="row-edit"
                aria-label={`Rename ${s.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditing({ id: s.id, value: s.title })
                }}
              >
                <Icon name="edit" size={13} />
              </button>
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
