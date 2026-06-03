/* ============================================================
   sidebar.jsx — session list, search, filters, modals
   ============================================================ */
const { useState, useEffect, useRef } = React;

const FILTERS = [
  { id: 'all',         label: 'All' },
  { id: 'running',     label: 'Live',        color: 'var(--st-running)' },
  { id: 'interrupted', label: 'Paused',      color: 'var(--st-pending)' },
  { id: 'completed',   label: 'Done',        color: 'var(--st-done)' },
  { id: 'error',       label: 'Error',       color: 'var(--st-error)' },
];

function SessionRow({ s, active, onOpen, onDelete }) {
  const liveStatus = (s.status === 'running' || s.status === 'starting' || s.status === 'awaiting-approval');
  const meta = window.IC.STATUS_META[s.status] || {};
  return (
    <div className="srow" data-active={active} onClick={onOpen}>
      <span className="s-dot"><StatusDot status={s.status} pulse /></span>
      <div className="s-main">
        <div className="s-title">{s.title}</div>
        <div className="s-meta">
          <span style={{ color: meta.color }}>{meta.label}</span>
          <span className="sep">·</span>
          <span>{relTime(s.lastActivity)}</span>
        </div>
      </div>
      <div className="s-right">
        {s.unread > 0 && <span className="s-unread">{s.unread}</span>}
        <button className="row-del" title="Delete session" onClick={(e) => { e.stopPropagation(); onDelete(s); }}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  );
}

function Sidebar({ sessions, activeId, query, setQuery, filter, setFilter, onOpen, onDelete, onNew, syncing }) {
  const searchRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); searchRef.current && searchRef.current.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = sessions.filter(s => {
    const q = query.trim().toLowerCase();
    if (q && !s.title.toLowerCase().includes(q)) return false;
    if (filter === 'all') return true;
    if (filter === 'running') return s.status === 'running' || s.status === 'starting' || s.status === 'awaiting-approval';
    return s.status === filter;
  });

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="side-title">
          <span className="eyebrow">Sessions</span>
        </div>
        <div className="search">
          <input ref={searchRef} value={query} placeholder="Search sessions…"
            onChange={e => setQuery(e.target.value)} />
          <kbd>⌘K</kbd>
        </div>
      </div>

      <div className="session-list">
        {syncing && (
          <div style={{ padding: '4px 4px' }}>
            {[0,1,2].map(i => (
              <div className="srow" key={i} style={{ cursor: 'default' }}>
                <span className="skel" style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 5 }} />
                <div className="s-main skel-row" style={{ padding: 0 }}>
                  <span className="skel" style={{ width: '70%', height: 11 }} />
                  <span className="skel" style={{ width: '40%', height: 9 }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {!syncing && filtered.length === 0 && (
          <div style={{ padding: '34px 16px', textAlign: 'center', color: 'var(--text-dim)' }}>
            <div style={{ fontSize: 12, letterSpacing: '.02em' }}>
              {query ? 'No sessions match' : 'No sessions yet'}
            </div>
            {query &&
              <button className="btn sm ghost" style={{ marginTop: 10 }}
                onClick={() => { setQuery(''); }}>Clear search</button>}
          </div>
        )}

        {!syncing && filtered.map(s => (
          <SessionRow key={s.id} s={s} active={s.id === activeId}
            onOpen={() => onOpen(s.id)} onDelete={onDelete} />
        ))}
      </div>

      <div className="side-foot">
        <button className="btn primary block" onClick={onNew}>New session</button>
      </div>
    </aside>
  );
}

/* ---------- New session modal ---------- */
function NewSessionModal({ onClose, onCreate }) {
  const [task, setTask] = useState('');
  const [model, setModel] = useState('sonnet');
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  const submit = () => { if (task.trim()) onCreate({ task: task.trim(), model }); };
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>New session</h3>
        </div>
        <div className="modal-body">
          <textarea ref={ref} className="prompt-input" value={task}
            placeholder="What should we do?"
            onChange={e => setTask(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }} />
          <div className="opt-row">
            <span className="eyebrow" style={{ alignSelf: 'center', marginRight: 2 }}>Model</span>
            {['sonnet', 'opus', 'haiku'].map(m => (
              <button key={m} className="opt" data-on={model === m} onClick={() => setModel(m)}>
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!task.trim()} onClick={submit}>
            Start session
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Delete confirm modal ---------- */
function ConfirmModal({ session, onClose, onConfirm }) {
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal sm" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Delete session?</h3>
          <p>“{session.title}” and its trace will be removed.</p>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Keep</button>
          <button className="btn danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Sidebar, SessionRow, NewSessionModal, ConfirmModal });
