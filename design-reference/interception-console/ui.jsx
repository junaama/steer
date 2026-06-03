/* ============================================================
   ui.jsx — icons + small presentational primitives
   Exports to window for cross-file use.
   ============================================================ */
const { useState, useEffect, useRef, useLayoutEffect, useCallback } = React;

/* ---- Icon set: minimal stroke line icons (16px grid) ---- */
function Icon({ name, size = 16, stroke = 1.6, style }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round', style };
  const paths = {
    search:   <><circle cx="11" cy="11" r="7"/><path d="M21 21l-3.6-3.6"/></>,
    plus:     <><path d="M12 5v14M5 12h14"/></>,
    x:        <><path d="M6 6l12 12M18 6L6 18"/></>,
    check:    <><path d="M4 12.5l5 5L20 6.5"/></>,
    chevron:  <><path d="M9 6l6 6-6 6"/></>,
    chevdown: <><path d="M6 9l6 6 6-6"/></>,
    swap:     <><path d="M7 10l-3 3 3 3"/><path d="M4 13h12a4 4 0 0 0 4-4"/><path d="M17 14l3-3-3-3"/><path d="M20 11H8a4 4 0 0 0-4 4" opacity=".0"/></>,
    edit:     <><path d="M14 5l5 5"/><path d="M4 20l1-4L17 4l3 3L8 19l-4 1z"/></>,
    pause:    <><path d="M8 5v14M16 5v14"/></>,
    play:     <><path d="M7 5l12 7-12 7V5z"/></>,
    trash:    <><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></>,
    bolt:     <><path d="M13 3L5 13h6l-1 8 8-12h-6l1-6z"/></>,
    wrench:   <><path d="M21 7a4 4 0 0 1-5.3 3.8L7 19.5 4.5 17l8.7-8.7A4 4 0 0 1 18 3.6l-2.6 2.6 1.4 1.4L19.4 5A4 4 0 0 1 21 7z"/></>,
    file:     <><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></>,
    read:     <><path d="M4 5h7v15H4z"/><path d="M13 5h7v15h-7z" opacity=".5"/><path d="M11 5c0-1 2-1 2 0"/></>,
    grep:     <><circle cx="10" cy="10" r="6"/><path d="M19 19l-4.5-4.5"/></>,
    folder:   <><path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></>,
    spinner:  <><path d="M12 3a9 9 0 1 0 9 9" /></>,
    brain:    <><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 2 4 3 3 0 0 0 5 1 3 3 0 0 0 5-1 3 3 0 0 0 2-4 3 3 0 0 0-1-5 3 3 0 0 0-3-3 3 3 0 0 0-3-1 3 3 0 0 0-3 1z"/></>,
    msg:      <><path d="M4 5h16v11H9l-4 3v-3H4z"/></>,
    sun:      <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></>,
    moon:     <><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></>,
    logout:   <><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="M16 16l4-4-4-4M20 12H9"/></>,
    bell:     <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 0 0 4 0"/></>,
    warn:     <><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/></>,
    plug:     <><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v5"/></>,
    arrowdown:<><path d="M12 5v14M6 13l6 6 6-6"/></>,
    dot:      <><circle cx="12" cy="12" r="3"/></>,
    sliders:  <><path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/></>,
    sparkle:  <><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></>,
  };
  return <svg {...p}>{paths[name] || paths.dot}</svg>;
}

const TOOL_ICON = { read: 'read', grep: 'grep', glob: 'folder', ls: 'folder', outline: 'file', write_file: 'file', default: 'wrench' };
function toolIcon(name) { return TOOL_ICON[name] || TOOL_ICON.default; }

/* ---- status dot used in sidebar / pills ---- */
function StatusDot({ status, size = 8, pulse }) {
  const meta = window.IC.STATUS_META[status] || { color: 'var(--text-dim)' };
  const animate = pulse && (status === 'running' || status === 'starting' || status === 'awaiting-approval');
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size }}>
      <span style={{ display: 'block', width: size, height: size, borderRadius: '50%', background: meta.color,
        boxShadow: status === 'awaiting-approval' ? '0 0 0 2px color-mix(in oklab, '+meta.color+' 25%, transparent)' : 'none' }} />
      {animate && <span style={{ position: 'absolute', inset: -3, borderRadius: '50%', border: '1.5px solid '+meta.color,
        opacity: .5, animation: 'pulse 1.5s ease-out infinite' }} />}
    </span>
  );
}

/* ---- session status pill ---- */
function StatusPill({ status }) {
  const meta = window.IC.STATUS_META[status] || { label: status, color: 'var(--text-dim)' };
  const live = status === 'running' || status === 'starting' || status === 'awaiting-approval';
  return (
    <span className="statuspill" style={{ color: meta.color,
      borderColor: 'color-mix(in oklab, '+meta.color+' 38%, var(--border))',
      background: 'color-mix(in oklab, '+meta.color+' 9%, transparent)' }}>
      {live ? <span className="pulse-dot" style={{ '--status': meta.color }} /> : <span style={{ width:7,height:7,borderRadius:'50%',background:meta.color }} />}
      {meta.label}
    </span>
  );
}

/* ---- tool-call status badge ---- */
function StatBadge({ status }) {
  const meta = window.IC.TOOL_STATUS_META[status] || { label: status, color: 'var(--text-dim)' };
  return (
    <span className="statbadge" style={{ '--status': meta.color }}>
      <span style={{ width:6,height:6,borderRadius:'50%',background:meta.color }} />
      {meta.label}
    </span>
  );
}

/* ---- relative time ---- */
function relTime(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

Object.assign(window, { Icon, toolIcon, StatusDot, StatusPill, StatBadge, relTime });
