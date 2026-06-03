/* ============================================================
   app.jsx — synced store projection, streaming engine, app shell
   ============================================================ */
const { useState, useEffect, useRef, useLayoutEffect, useCallback } = React;

/* ---------- canned read-tool results (for substitutes) ---------- */
function cannedRead(name) {
  switch (name) {
    case 'read':    return '12  export async function login(req) {\n13    const token = req.cookies.sid\n14    const session = await store.get(token)\n…\n26    return null   // ← always null; bug\n27  }';
    case 'grep':    return 'src/login.ts:26:  return null\nsrc/login.ts:24:  return null\n— 2 matches in 1 file';
    case 'glob':    return 'src/login.ts\nsrc/routes/auth.ts\n— 2 files';
    case 'ls':      return 'src/\n  login.ts\n  routes/\n  lib/\n— 3 entries';
    case 'outline': return 'login(req)        fn   @ 12\nstore.get(token)  call @ 14\nreturn null       stmt @ 26';
    default:        return 'completed';
  }
}

let _eidSeq = 0;
const newEid = () => 'ev-' + (++_eidSeq) + '-' + Math.random().toString(36).slice(2, 6);

/* ============================================================
   Streaming engine — one controller per session
   ============================================================ */
function createEngine({ id, script, patchSession, patchEvent, appendEvent, setStatus, bump, toast, onComplete }) {
  let stepIndex = 0;
  let timers = [];
  let currentToolId = null;
  let currentText = null; // { id, full } while a text step streams
  let alive = true;

  const T = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };

  function clearAll() {
    timers.forEach(t => { if (t && t.__iv) clearInterval(t.__iv); else clearTimeout(t); });
    timers = [];
  }

  function streamText(evId, full, dur, after) {
    currentText = { id: evId, full };
    const chunks = full.split(/(\s+)/);
    let i = 0;
    const tick = Math.max(18, Math.min(60, dur / chunks.length));
    const iv = setInterval(() => {
      if (!alive) { clearInterval(iv); return; }
      i += 1;
      patchEvent(evId, { text: chunks.slice(0, i).join('') });
      bump();
      if (i >= chunks.length) {
        clearInterval(iv);
        currentText = null;
        patchEvent(evId, { text: full, done: true });
        T(after, 420);
      }
    }, tick);
    timers.push({ __iv: iv });
  }

  function step(i) {
    if (!alive) return;
    stepIndex = i;
    if (i >= script.length) { return finishRun(); }
    const s = script[i];

    if (s.t === 'complete') { return finishRun(); }

    if (s.t === 'thinking' || s.t === 'say') {
      const evId = newEid();
      appendEvent({ id: evId, type: s.t === 'thinking' ? 'thinking' : 'message', role: 'assistant', text: '', done: false });
      streamText(evId, s.text, s.dur || 1200, () => step(i + 1));
      return;
    }

    if (s.t === 'tool') {
      const evId = newEid();
      const base = {
        id: evId, type: 'tool', name: s.name, kind: s.kind, args: { ...s.args },
        argOrder: s.argOrder, diff: s.diff || null, result: null, _step: i,
      };
      if (s.kind === 'write' && s.gate === 'approve') {
        appendEvent({ ...base, status: 'pending' });
        currentToolId = evId;
        setStatus('awaiting-approval');
        toast('Tool needs approval — write_file ' + s.args.path, 'warn');
        bump();
        return; // wait for operator
      }
      // read-only (running window)
      appendEvent({ ...base, status: 'running' });
      currentToolId = evId;
      setStatus('running');
      bump();
      T(() => {
        if (!alive || currentToolId !== evId) return; // preempted by operator
        patchEvent(evId, { status: 'done', result: s.result });
        currentToolId = null;
        bump();
        step(i + 1);
      }, s.runMs || 4000);
      return;
    }
    step(i + 1);
  }

  function finishRun() {
    setStatus('completed');
    currentToolId = null;
    onComplete && onComplete();
  }

  /* ---- operator interception on the current tool ---- */
  function resolve(evId, action, payload) {
    if (evId !== currentToolId) return;
    clearAll();
    const at = stepIndex;

    if (action === 'approve') {
      patchEvent(evId, { status: 'running', result: null });
      setStatus('running'); bump();
      T(() => {
        patchEvent(evId, { status: 'done', result: script[at].result });
        currentToolId = null; bump(); step(at + 1);
      }, 850);
      return;
    }
    if (action === 'reject') {
      patchEvent(evId, { status: 'cancelled', result: 'Rejected by operator — file was not written.' });
      setStatus('running'); currentToolId = null; bump();
      // graceful close instead of running the remaining "patched" narrative
      const mid = newEid();
      T(() => {
        appendEvent({ id: mid, type: 'message', role: 'assistant', text: '', done: false });
        streamText(mid, 'Understood — leaving the file unchanged. Want me to take a different approach?', 1400, finishRun);
      }, 500);
      toast('Write rejected — file untouched');
      return;
    }
    if (action === 'cancel') {
      patchEvent(evId, { status: 'cancelled', result: 'Cancelled by operator.' });
      currentToolId = null; setStatus('running'); bump();
      T(() => step(at + 1), 500);
      toast('Tool cancelled');
      return;
    }
    if (action === 'swap') {
      const from = script[at].name;
      patchEvent(evId, {
        status: 'running', substitutedFrom: from, name: payload, kind: 'read',
        diff: null, result: null,
        args: payload === 'read' ? { path: 'src/login.ts' } : { ...script[at].args },
        argOrder: payload === 'read' ? ['path'] : script[at].argOrder,
      });
      setStatus('running'); bump();
      T(() => {
        patchEvent(evId, { status: 'substituted', result: cannedRead(payload) });
        currentToolId = null; bump(); step(at + 1);
      }, 950);
      toast('Substituted ' + from + ' → ' + payload);
      return;
    }
    if (action === 'edit') {
      const isWrite = script[at].kind === 'write';
      patchEvent(evId, { status: 'running', editedArgs: true, args: payload, result: null });
      setStatus('running'); bump();
      T(() => {
        patchEvent(evId, {
          status: 'done',
          result: isWrite ? script[at].result : cannedRead(script[at].name),
        });
        currentToolId = null; bump(); step(at + 1);
      }, 900);
      toast('Ran ' + script[at].name + ' with edited args');
      return;
    }
  }

  return {
    start() { step(stepIndex); },
    resume() { alive = true; step(stepIndex); },
    pause() {
      clearAll();
      // freeze whatever is mid-flight, then set resume point to the next step
      if (currentText) { patchEvent(currentText.id, { text: currentText.full, done: true }); currentText = null; }
      if (currentToolId) {
        const s = script[stepIndex];
        if (s && s.t === 'tool' && s.kind !== 'write') patchEvent(currentToolId, { status: 'done', result: s.result });
        currentToolId = null;
      }
      stepIndex = Math.min(stepIndex + 1, script.length);
      bump();
    },
    kill() { alive = false; clearAll(); },
    resolve,
    hasCurrent: () => currentToolId,
  };
}

/* ============================================================
   DETAIL PANE
   ============================================================ */
function Detail({ session, onAction, onInterrupt, onContinue, onRetry, tick }) {
  const scrollRef = useRef(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = () => {
    const el = scrollRef.current; if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = atBottom;
    setShowJump(!atBottom);
  };
  const toBottom = (smooth = true) => {
    const el = scrollRef.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickRef.current = true; setShowJump(false);
  };

  useLayoutEffect(() => {
    if (stickRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  });
  // eslint-disable-next-line
  useEffect(() => { stickRef.current = true; setShowJump(false); }, [session.id]);

  const meta = window.IC.STATUS_META[session.status] || {};
  const isLive = session.status === 'running' || session.status === 'awaiting-approval' || session.status === 'starting';
  const isErr = session.status === 'error';
  const events = session.events || [];

  return (
    <section className="main">
      <header className="detail-head">
        <div className="dh-main">
          <h1>{session.title}</h1>
          <div className="dh-sub">
            <span>{session.model || 'sonnet'}</span>
            <span style={{ opacity: .4 }}>·</span>
            <span>{events.length} events</span>
            <span style={{ opacity: .4 }}>·</span>
            <span>updated {relTime(session.lastActivity)}</span>
          </div>
        </div>
        <StatusPill status={session.status} />
        <div className="dh-actions">
          {isLive && (
            <button className="btn sm" onClick={onInterrupt}>Interrupt</button>
          )}
          {session.status === 'interrupted' && (
            <button className="btn sm primary" onClick={onContinue}>Continue</button>
          )}
          {isErr && (
            <button className="btn sm primary" onClick={onRetry}>Reconnect &amp; retry</button>
          )}
        </div>
      </header>

      <div className="trace-wrap">
        <div className="trace" ref={scrollRef} onScroll={onScroll}>
          <div className="trace-inner">
            {isErr && (
              <div className="banner" style={{ marginTop: 0, marginBottom: 18 }}>
                <span>{session.errored}</span>
                <span className="b-act"><button className="btn sm" onClick={onRetry}>Reconnect</button></span>
              </div>
            )}
            {session.status === 'interrupted' && (
              <div className="banner warn" style={{ marginTop: 0, marginBottom: 18 }}>
                <span>Run interrupted by operator. Resume to continue from where it left off.</span>
                <span className="b-act"><button className="btn sm primary" onClick={onContinue}>Continue</button></span>
              </div>
            )}

            {events.length === 0 && session.status === 'starting' && (
              <div style={{ padding: '8px 0' }}>
                <div className="eyebrow" style={{ marginBottom: 14 }}><span className="pulse-dot" style={{ '--status': 'var(--st-running)', display: 'inline-block' }} /> &nbsp;connecting to run…</div>
                {[0,1].map(i => (<div className="skel-row" key={i}><span className="skel" style={{ width: i ? '55%' : '80%', height: 12 }} /><span className="skel" style={{ width: '40%', height: 12 }} /></div>))}
              </div>
            )}

            {events.map(ev => <TraceEvent key={ev.id} ev={ev} onAction={onAction} />)}

            {isLive && events.length > 0 && (
              <div className="live-tail"><span className="ld" /> live — following</div>
            )}
          </div>
        </div>
        <button className="jumplive" data-show={showJump} onClick={() => toBottom(true)}>
          Jump to live
        </button>
      </div>
    </section>
  );
}

/* ============================================================
   APP
   ============================================================ */
function App() {
  const [sessions, setSessions] = useState(() => window.IC.SESSIONS.map(s => ({ ...s, events: s.events.map(e => ({ ...e })) })));
  const [activeId, setActiveId] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [theme, setTheme] = useState(() => localStorage.getItem('ic-theme') || 'dark');
  const [syncing, setSyncing] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [, force] = useState(0);
  const bump = useCallback(() => force(x => x + 1), []);

  const engines = useRef({});
  const started = useRef({});

  /* theme — suppress transitions during the swap so var-driven colors snap cleanly */
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('no-trans');
    root.setAttribute('data-theme', theme);
    localStorage.setItem('ic-theme', theme);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-trans')));
    return () => cancelAnimationFrame(id);
  }, [theme]);

  /* initial sync + deep-link */
  useEffect(() => {
    const t = setTimeout(() => {
      setSyncing(false);
      const hash = (location.hash.match(/#\/s\/(.+)$/) || [])[1];
      const first = window.IC.SESSIONS[0].id;
      open(hash && window.IC.SESSIONS.some(s => s.id === hash) ? hash : first);
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, []);

  /* relative-time refresh */
  useEffect(() => { const iv = setInterval(bump, 15000); return () => clearInterval(iv); }, [bump]);

  const toast = useCallback((text) => {
    const id = newEid();
    setToasts(t => [...t, { id, text }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2800);
  }, []);

  /* ---- store mutators (immutable projections) ---- */
  const patchSession = useCallback((sid, patch) => {
    setSessions(prev => prev.map(s => s.id === sid ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch), lastActivity: Date.now() } : s));
  }, []);
  const setStatus = useCallback((sid, status) => patchSession(sid, { status }), [patchSession]);
  const appendEvent = useCallback((sid, ev) => {
    setSessions(prev => prev.map(s => s.id === sid ? { ...s, events: [...s.events, ev], lastActivity: Date.now() } : s));
  }, []);
  const patchEvent = useCallback((sid, evId, patch) => {
    setSessions(prev => prev.map(s => s.id === sid ? { ...s, events: s.events.map(e => e.id === evId ? { ...e, ...patch } : e) } : s));
  }, []);

  /* ---- open a session (autostarts the headline demo on first open) ---- */
  const open = (sid) => {
    setActiveId(sid);
    history.replaceState(null, '', '#/s/' + sid);
    patchSession(sid, { unread: 0 });
    const s = (sessions.find(x => x.id === sid)) || window.IC.SESSIONS.find(x => x.id === sid);
    if (s && s.autostart && !started.current[sid]) {
      started.current[sid] = true;
      setStatus(sid, 'starting');
      setTimeout(() => {
        setStatus(sid, 'running');
        const eng = ensureEngineFor(sid);
        eng && eng.start();
      }, 850);
    }
  };

  // ensureEngine that reads latest script directly (avoids stale closure on first open)
  const ensureEngineFor = (sid) => {
    const seed = window.IC.SESSIONS.find(s => s.id === sid);
    const script = seed && seed.script;
    if (!script) return null;
    if (!engines.current[sid]) {
      engines.current[sid] = createEngine({
        id: sid, script,
        patchEvent: (evId, p) => patchEvent(sid, evId, p),
        appendEvent: (ev) => appendEvent(sid, ev),
        setStatus: (st) => setStatus(sid, st),
        bump, toast, onComplete: () => {},
      });
    }
    return engines.current[sid];
  };

  /* ---- interception action from a tool card ---- */
  const onAction = (ev, type, payload) => {
    const eng = engines.current[activeId];
    if (eng) eng.resolve(ev.id, type, payload);
  };

  const onInterrupt = () => {
    const eng = engines.current[activeId];
    if (eng) eng.pause();
    setStatus(activeId, 'interrupted');
    toast('Run interrupted');
  };
  const onContinue = () => {
    setStatus(activeId, 'running');
    let eng = engines.current[activeId];
    if (!eng) eng = ensureEngineFor(activeId);
    eng && eng.resume();
    toast('Run resumed');
  };
  const onRetry = () => {
    patchSession(activeId, { status: 'running', errored: null });
    let eng = engines.current[activeId];
    if (!eng) eng = ensureEngineFor(activeId);
    eng && eng.resume();
    toast('Reconnected — resuming');
  };

  /* ---- create / delete ---- */
  const createSession = ({ task, model }) => {
    const id = 'new-' + Date.now().toString(36);
    const title = task.length > 42 ? task.slice(0, 40).trim() + '…' : task;
    const seed = { id, title, status: 'starting', created: Date.now(), lastActivity: Date.now(), unread: 0, task, model, events: [], script: window.IC.SCRIPT_GENERIC, autostart: false };
    window.IC.SESSIONS.unshift(seed); // keep script discoverable to engine factory
    setSessions(prev => [{ ...seed, events: [] }, ...prev]);
    setNewOpen(false);
    setActiveId(id);
    history.replaceState(null, '', '#/s/' + id);
    toast('Session created');
    setTimeout(() => {
      setStatus(id, 'running');
      const eng = ensureEngineFor(id);
      eng && eng.start();
    }, 950);
  };

  const doDelete = (s) => {
    const eng = engines.current[s.id];
    if (eng) eng.kill();
    delete engines.current[s.id];
    setSessions(prev => prev.filter(x => x.id !== s.id));
    window.IC.SESSIONS = window.IC.SESSIONS.filter(x => x.id !== s.id);
    setConfirm(null);
    toast('Session deleted');
    if (activeId === s.id) {
      const rest = sessions.filter(x => x.id !== s.id);
      if (rest.length) open(rest[0].id); else setActiveId(null);
    }
  };

  const active = sessions.find(s => s.id === activeId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          steer
        </div>
        <div className="spacer" />
        <button className="topbtn icononly" title="Toggle theme" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
        </button>
        <div className="userchip">
          <span className="av">AK</span>
          <span>arjun@acme.dev</span>
        </div>
        <button className="topbtn" title="Logout (flushes synced rows + reloads)" onClick={() => toast('Logout flushes synced state + reloads')}>
          Logout
        </button>
      </header>

      <div className="body">
        <Sidebar
          sessions={sessions} activeId={activeId} query={query} setQuery={setQuery}
          filter={filter} setFilter={setFilter} onOpen={open}
          onDelete={(s) => setConfirm(s)} onNew={() => setNewOpen(true)} syncing={syncing} />

        {active ? (
          <Detail session={active} onAction={onAction}
            onInterrupt={onInterrupt} onContinue={onContinue} onRetry={onRetry} />
        ) : (
          <div className="main"><div className="placeholder"><div className="ph-card">
            <h2>No session selected</h2>
            <p>Pick a session from the left, or start a new one. The agent streams its work here — step into any tool call to intercept it live.</p>
            <button className="btn primary" onClick={() => setNewOpen(true)}>New session</button>
          </div></div></div>
        )}
      </div>

      {newOpen && <NewSessionModal onClose={() => setNewOpen(false)} onCreate={createSession} />}
      {confirm && <ConfirmModal session={confirm} onClose={() => setConfirm(null)} onConfirm={() => doDelete(confirm)} />}

      <div className="toasts">
        {toasts.map(t => (
          <div className="toast" key={t.id}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
