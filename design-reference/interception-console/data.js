/* ============================================================
   data.js — seed sessions + scripted live-run timelines + tool registry
   All collections here stand in for Electric/TanStack-synced shapes.
   Plain JS; attaches to window.IC.
   ============================================================ */
(function () {
  // ---- Read-only tool registry (valid swap substitutes) ----
  const READ_TOOLS = [
    { name: 'read',  desc: 'Read a file’s contents', kind: 'read' },
    { name: 'grep',  desc: 'Search file contents by regex', kind: 'read' },
    { name: 'glob',  desc: 'Match files by path pattern', kind: 'read' },
    { name: 'ls',    desc: 'List a directory', kind: 'read' },
    { name: 'outline', desc: 'Symbol outline of a file', kind: 'read' },
  ];

  // shorthand for relative timestamps
  const mins = (n) => Date.now() - n * 60000;

  /* ----------------------------------------------------------
     SCRIPT FORMAT — interpreted by the streaming engine.
     step.t: 'thinking' | 'say' | 'tool' | 'complete'
       thinking/say: { text, dur }  (dur ~ ms to stream)
       tool: {
         name, kind:'read'|'write', args:{}, argOrder:[],
         gate: 'read' | 'approve' | null,
         runMs,                 // running window before auto-resolve (read)
         result,                // text result (read/done)
         resultRich,            // optional html-ish tokens
         diff: { file, add, del, hunk:[ {t:'ctx'|'add'|'del', n, code} ] }
       }
     ---------------------------------------------------------- */

  const SCRIPT_AUTH = [
    { t: 'thinking', text: 'The task is to make login return the active session instead of null. Before editing anything I should locate the current auth entry points so I patch the right handler.', dur: 2600 },
    { t: 'say', text: 'I’ll start by finding where login is handled across the codebase.', dur: 1100 },
    {
      t: 'tool', name: 'grep', kind: 'read', gate: 'read', runMs: 9000,
      args: { pattern: 'login', path: 'src/', flags: '-rn' }, argOrder: ['pattern', 'path', 'flags'],
      result: 'src/login.ts:12:export async function login(req)\nsrc/login.ts:24:  return null\nsrc/routes/auth.ts:8:  const r = await login(req)\nsrc/routes/auth.ts:40:  // login redirect\n— 4 matches in 2 files',
    },
    { t: 'say', text: 'The handler lives in src/login.ts. Let me read it to see exactly what it returns.', dur: 1300 },
    {
      t: 'tool', name: 'read', kind: 'read', gate: null, runMs: 2600,
      args: { path: 'src/login.ts', range: '1-30' }, argOrder: ['path', 'range'],
      result: '12  export async function login(req) {\n13    const token = req.cookies.sid\n14    const session = await store.get(token)\n…\n23    if (!session) {\n24      return null\n25    }\n26    return null   // ← always null; bug\n27  }',
    },
    { t: 'thinking', text: 'Line 26 returns null unconditionally even when a valid session exists — that’s the bug. The fix is to return the resolved session object.', dur: 2200 },
    { t: 'say', text: 'Found it: line 26 always returns null. I’ll patch it to return the resolved session.', dur: 1300 },
    {
      t: 'tool', name: 'write_file', kind: 'write', gate: 'approve',
      args: { path: 'src/login.ts', encoding: 'utf-8' }, argOrder: ['path', 'encoding'],
      result: 'Wrote src/login.ts · +1 −1',
      diff: {
        file: 'src/login.ts', add: 1, del: 1,
        hunk: [
          { t: 'ctx', n: '23', code: '    if (!session) {' },
          { t: 'ctx', n: '24', code: '      return null' },
          { t: 'ctx', n: '25', code: '    }' },
          { t: 'del', n: '26', code: '    return null   // ← always null; bug' },
          { t: 'add', n: '26', code: '    return session' },
          { t: 'ctx', n: '27', code: '  }' },
        ],
      },
    },
    { t: 'say', text: 'Patched. login now returns the active session when one resolves. Want me to add a regression test for the null path?', dur: 1500 },
    { t: 'complete' },
  ];

  const SCRIPT_GENERIC = [
    { t: 'thinking', text: 'Let me understand the request and locate the relevant code before making any changes.', dur: 2000 },
    { t: 'say', text: 'Scanning the repository for the modules involved.', dur: 1000 },
    {
      t: 'tool', name: 'ls', kind: 'read', gate: 'read', runMs: 8000,
      args: { path: 'src/', depth: '2' }, argOrder: ['path', 'depth'],
      result: 'src/\n  index.ts\n  login.ts\n  routes/\n    auth.ts\n  lib/\n    store.ts\n— 6 entries',
    },
    { t: 'say', text: 'I have the layout. Reading the primary entry file.', dur: 1100 },
    {
      t: 'tool', name: 'read', kind: 'read', gate: null, runMs: 2400,
      args: { path: 'src/index.ts' }, argOrder: ['path'],
      result: '1  import { createServer } from "./lib/server"\n2  createServer().listen(3000)',
    },
    { t: 'say', text: 'Drafting the change now.', dur: 1200 },
    {
      t: 'tool', name: 'write_file', kind: 'write', gate: 'approve',
      args: { path: 'src/index.ts', encoding: 'utf-8' }, argOrder: ['path', 'encoding'],
      result: 'Wrote src/index.ts · +1 −0',
      diff: {
        file: 'src/index.ts', add: 1, del: 0,
        hunk: [
          { t: 'ctx', n: '1', code: 'import { createServer } from "./lib/server"' },
          { t: 'add', n: '2', code: 'import "./instrument"  // tracing' },
          { t: 'ctx', n: '3', code: 'createServer().listen(3000)' },
        ],
      },
    },
    { t: 'say', text: 'Change staged. Anything else you’d like me to wire up?', dur: 1300 },
    { t: 'complete' },
  ];

  // ---- Seed sessions (synced projection) ----
  // events[] are pre-rendered for finished/idle sessions; running ones stream.
  const SESSIONS = [
    {
      id: 'add-auth', title: 'Add session-aware auth', status: 'idle',
      created: mins(7), lastActivity: mins(0.2), unread: 0,
      task: 'login() returns null even when a valid session exists — make it return the active session.',
      script: SCRIPT_AUTH, events: [], cursor: 0, autostart: true, model: 'sonnet',
    },
    {
      id: 'fix-bug', title: 'Fix flaky checkout test', status: 'completed',
      created: mins(52), lastActivity: mins(36), unread: 0,
      task: 'The checkout integration test fails ~1 in 5 runs.',
      model: 'sonnet',
      events: [
        { id: 'e1', type: 'message', role: 'assistant', text: 'The flake is a race on the cart-clear call. I added an await and the test is green across 50 runs.', done: true },
        { id: 'e2', type: 'tool', name: 'grep', kind: 'read', status: 'done', args: { pattern: 'cartClear', path: 'tests/' }, argOrder: ['pattern','path'], result: 'tests/checkout.test.ts:88: cartClear()\n— 1 match' },
        { id: 'e3', type: 'tool', name: 'write_file', kind: 'write', status: 'done', args: { path: 'tests/checkout.test.ts' }, argOrder:['path'], result: 'Wrote tests/checkout.test.ts · +1 −1',
          diff: { file: 'tests/checkout.test.ts', add: 1, del: 1, hunk: [
            { t:'del', n:'88', code:'  cartClear()' },
            { t:'add', n:'88', code:'  await cartClear()' },
          ] } },
        { id: 'e4', type: 'message', role: 'assistant', text: 'Done — 50/50 passing. Closed out.', done: true },
      ], cursor: 0,
    },
    {
      id: 'deploy', title: 'Stage v2.4 to preview', status: 'interrupted',
      created: mins(120), lastActivity: mins(74), unread: 0,
      task: 'Build and push the v2.4 branch to the preview environment.',
      model: 'opus',
      events: [
        { id: 'e1', type: 'message', role: 'assistant', text: 'Building the v2.4 bundle before pushing to preview.', done: true },
        { id: 'e2', type: 'tool', name: 'ls', kind: 'read', status: 'done', args: { path: 'dist/' }, argOrder:['path'], result: 'dist/ — empty (needs build)' },
        { id: 'e3', type: 'message', role: 'assistant', text: 'Kicking off the production build…', done: true },
      ], cursor: 0,
    },
    {
      id: 'spike', title: 'Spike: vector search index', status: 'error',
      created: mins(210), lastActivity: mins(180), unread: 0,
      task: 'Prototype a pgvector index over the docs table and benchmark recall.',
      model: 'sonnet',
      errored: 'Sync connection lost while streaming tool results. The run is paused server-side.',
      events: [
        { id: 'e1', type: 'message', role: 'assistant', text: 'Setting up a pgvector extension and a throwaway index to benchmark.', done: true },
        { id: 'e2', type: 'tool', name: 'grep', kind: 'read', status: 'done', args: { pattern: 'CREATE EXTENSION', path: 'migrations/' }, argOrder:['pattern','path'], result: '— 0 matches' },
      ], cursor: 0,
    },
  ];

  window.IC = {
    READ_TOOLS,
    SCRIPT_AUTH, SCRIPT_GENERIC,
    SESSIONS,
    STATUS_META: {
      'idle':              { label: 'idle',        color: 'var(--text-dim)' },
      'starting':          { label: 'connecting',  color: 'var(--st-running)' },
      'running':           { label: 'running',     color: 'var(--st-running)' },
      'awaiting-approval': { label: 'awaiting approval', color: 'var(--st-pending)' },
      'interrupted':       { label: 'interrupted', color: 'var(--st-pending)' },
      'completed':         { label: 'completed',   color: 'var(--st-done)' },
      'error':             { label: 'error',       color: 'var(--st-error)' },
    },
    TOOL_STATUS_META: {
      proposed:    { label: 'proposed',    color: 'var(--st-proposed)' },
      pending:     { label: 'needs approval', color: 'var(--st-pending)' },
      running:     { label: 'running',     color: 'var(--st-running)' },
      cancelled:   { label: 'cancelled',   color: 'var(--st-cancelled)' },
      substituted: { label: 'substituted', color: 'var(--st-substituted)' },
      done:        { label: 'done',        color: 'var(--st-done)' },
      error:       { label: 'error',       color: 'var(--st-error)' },
    },
  };
})();
