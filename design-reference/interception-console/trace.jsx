/* ============================================================
   trace.jsx — live trace, tool cards, diff, interception controls
   ============================================================ */
const { useState, useEffect, useRef } = React;

/* ---------- argument inline summary ---------- */
function argSummary(ev) {
  const order = ev.argOrder || Object.keys(ev.args || {});
  const primary = order[0];
  if (!primary) return null;
  return (
    <span className="tc-args-inline">
      <b>{String(ev.args[primary])}</b>
      {order.length > 1 ? '  ·  +' + (order.length - 1) : ''}
    </span>
  );
}

/* ---------- diff ---------- */
function Diff({ diff }) {
  return (
    <div className="diff fade-in">
      <div className="diff-file">
        <span style={{ color: 'var(--text-strong)' }}>{diff.file}</span>
        <span style={{ marginLeft: 'auto' }} className="stat-add">+{diff.add}</span>
        <span className="stat-del">−{diff.del}</span>
      </div>
      <div>
        {diff.hunk.map((l, i) => (
          <div className="diff-line" data-t={l.t} key={i}>
            <span className="gut">{l.n}</span>
            <span className="sign">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
            <span className="code">{l.code}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- streaming result block ---------- */
function ResultBlock({ text }) {
  return <div className="result-block fade-in">{text}</div>;
}

/* ---------- swap picker ---------- */
function SwapPicker({ current, onPick, onClose }) {
  const tools = window.IC.READ_TOOLS.filter(t => t.name !== current);
  return (
    <div className="subpanel fade-in">
      <div className="sp-head">
        <span className="eyebrow">Substitute with a read-only tool</span>
        <button className="row-del" style={{ opacity: 1 }} onClick={onClose}><Icon name="x" size={13} /></button>
      </div>
      {tools.map(t => (
        <div className="tool-opt" key={t.name} onClick={() => onPick(t.name)}>
          <div>
            <div className="to-name">{t.name}</div>
            <div className="to-desc">{t.desc}</div>
          </div>
          <span className="to-pick">SELECT →</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- args editor ---------- */
function ArgsEditor({ ev, onSubmit, onClose }) {
  const order = ev.argOrder || Object.keys(ev.args || {});
  const [vals, setVals] = useState(() => ({ ...ev.args }));
  return (
    <div className="subpanel fade-in">
      <div className="sp-head">
        <span className="eyebrow">Edit arguments · {ev.name}</span>
        <button className="row-del" style={{ opacity: 1 }} onClick={onClose}><Icon name="x" size={13} /></button>
      </div>
      <div className="argeditor">
        {order.map(k => (
          <div className="argfield" key={k}>
            <label>{k}</label>
            {String(vals[k]).length > 38
              ? <textarea rows={2} value={vals[k]} onChange={e => setVals(v => ({ ...v, [k]: e.target.value }))} />
              : <input value={vals[k]} onChange={e => setVals(v => ({ ...v, [k]: e.target.value }))} />}
          </div>
        ))}
        <div className="flex gap8" style={{ justifyContent: 'flex-end', marginTop: 2 }}>
          <button className="btn sm ghost" onClick={onClose}>Cancel</button>
          <button className="btn sm primary" onClick={() => onSubmit(vals)}>Run with edits</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- intercept control bar ---------- */
function InterceptControls({ ev, onAction }) {
  const [mode, setMode] = useState('view'); // view | swap | edit
  const isWrite = ev.kind === 'write';
  const pending = ev.status === 'pending';   // write awaiting approval
  const running = ev.status === 'running';   // read-only live

  const close = () => setMode('view');

  return (
    <div className="intercept">
      <div className="ic-head">
        <span className="eyebrow">
          {pending ? 'Will not run until you act' : 'Read-only · intervene live'}
        </span>
      </div>

      {mode === 'view' && (
        <div className="ic-actions">
          {pending ? (
            <>
              <button className="btn sm primary" onClick={() => onAction('approve')}>Approve</button>
              <button className="btn sm" onClick={() => setMode('swap')}>Swap → read-only</button>
              <button className="btn sm" onClick={() => setMode('edit')}>Edit args</button>
              <button className="btn sm danger" onClick={() => onAction('reject')}>Reject</button>
            </>
          ) : (
            <>
              <button className="btn sm" onClick={() => setMode('swap')}>Cancel &amp; swap → read</button>
              <button className="btn sm" onClick={() => setMode('edit')}>Edit args</button>
              <button className="btn sm danger" onClick={() => onAction('cancel')}>Cancel</button>
            </>
          )}
        </div>
      )}

      {mode === 'swap' && (
        <SwapPicker current={ev.name} onClose={close}
          onPick={(name) => { onAction('swap', name); close(); }} />
      )}
      {mode === 'edit' && (
        <ArgsEditor ev={ev} onClose={close}
          onSubmit={(args) => { onAction('edit', args); close(); }} />
      )}
    </div>
  );
}

/* ---------- tool card ---------- */
function ToolCard({ ev, onAction }) {
  const liveAttn = ev.status === 'pending';
  const live = ev.status === 'running' || ev.status === 'pending';
  const meta = window.IC.TOOL_STATUS_META[ev.status] || {};
  const [open, setOpen] = useState(live);

  // auto-open when it enters a live/interceptable state, auto-collapse long-done reads
  useEffect(() => {
    if (live) setOpen(true);
  }, [ev.status]);

  const hasResult = ev.result && (ev.status === 'done' || ev.status === 'substituted');
  const showDiff = ev.diff && (ev.status === 'pending' || ev.status === 'done');
  const canIntercept = ev.status === 'running' || ev.status === 'pending';

  return (
    <div className="toolcard" data-live={live} data-attn={liveAttn} style={{ '--status': meta.color }}>
      <div className="tc-head" onClick={() => setOpen(o => !o)}>
        <div className="grow">
          <span className="tc-name">{ev.name}</span>
          <span className="tc-kind" data-k={ev.kind}>{ev.kind === 'write' ? 'side-effect' : 'read-only'}</span>
          {argSummary(ev)}
        </div>
        <StatBadge status={ev.status} />
      </div>

      {ev.substitutedFrom && (
        <div className="audit">
          <span>operator substituted <span className="from">{ev.substitutedFrom}</span> → <span className="to">{ev.name}</span></span>
          <span style={{ marginLeft: 'auto', opacity: .6 }}>audit</span>
        </div>
      )}
      {ev.editedArgs && (
        <div className="audit">
          <span>operator edited arguments before running</span>
          <span style={{ marginLeft: 'auto', opacity: .6 }}>audit</span>
        </div>
      )}

      {open && (
        <div className="tc-body fade-in">
          <div className="tc-section">
            <div className="tc-label">Arguments</div>
            <div className="kv">
              {(ev.argOrder || Object.keys(ev.args || {})).map(k => (
                <React.Fragment key={k}>
                  <span className="k">{k}</span>
                  <span className="v">{String(ev.args[k])}</span>
                </React.Fragment>
              ))}
            </div>
          </div>

          {showDiff && (
            <div className="tc-section">
              <div className="tc-label">Proposed change</div>
              <Diff diff={ev.diff} />
            </div>
          )}

          {ev.status === 'running' && !ev.result && (
            <div className="tc-section">
              <div className="live-tail" style={{ paddingLeft: 0 }}>
                <span className="ld" /> executing…
              </div>
            </div>
          )}

          {hasResult && !ev.diff && (
            <div className="tc-section">
              <div className="tc-label">Result</div>
              <ResultBlock text={ev.result} />
            </div>
          )}
          {hasResult && ev.diff && ev.status === 'done' && (
            <div className="tc-section">
              <div className="tc-label">Outcome</div>
              <div className="result-block" style={{ color: 'var(--st-done)' }}>{ev.result}</div>
            </div>
          )}
          {ev.status === 'cancelled' && (
            <div className="tc-section">
              <div className="result-block" style={{ color: 'var(--st-cancelled)' }}>
                {ev.result || 'Cancelled by operator before execution.'}
              </div>
            </div>
          )}
        </div>
      )}

      {canIntercept && <InterceptControls ev={ev} onAction={(t, p) => onAction(ev, t, p)} />}
    </div>
  );
}

/* ---------- trace event router ---------- */
function TraceEvent({ ev, onAction }) {
  if (ev.type === 'tool') {
    return (
      <div className="ev">
        <ToolCard ev={ev} onAction={onAction} />
      </div>
    );
  }
  if (ev.type === 'thinking') {
    return (
      <div className="ev ev-thinking">
        <div className="ev-role">thinking</div>
        <div className="ev-body">{ev.text}{!ev.done && <span className="caret" />}</div>
      </div>
    );
  }
  // message
  return (
    <div className="ev ev-message">
      <div className="ev-role">assistant</div>
      <div className="ev-body">{ev.text}{!ev.done && <span className="caret" />}</div>
    </div>
  );
}

Object.assign(window, { Diff, ResultBlock, SwapPicker, ArgsEditor, InterceptControls, ToolCard, TraceEvent });
