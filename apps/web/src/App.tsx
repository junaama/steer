import { useMemo, useState, useEffect, type FormEvent } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { Shell } from './components/Shell.js'
import { Sidebar } from './components/Sidebar.js'
import { SessionDetail } from './components/SessionDetail.js'
import { InterceptControls, type InterceptAction } from './components/InterceptControls.js'
import { NewSessionModal } from './components/NewSessionModal.js'
import { ConfirmModal } from './components/ConfirmModal.js'
import { useSteerAuth, type SteerAuth } from './auth/AuthProvider.js'
import { createAuthedFetch, performLogout, type FetchLike } from './auth/authed-fetch.js'
import { createWriteClient, type WriteClient } from './lib/write-client.js'
import { createSessionsCollection, createEventsCollection, createEnvironmentsCollection } from './data/electric.js'
import { initialTheme, storeTheme, type Theme } from './lib/theme.js'
import { decodeSessionRow, decodeEventRow, decodeEnvironmentRow } from './data/decode.js'
import { buildTrace, latestPlan, type ToolItem } from './lib/trace.js'
import { randomId } from './lib/id.js'
import type { SessionView, FilterId } from './lib/filter.js'
import type { SessionRow, EventRow, EnvironmentRow } from './data/types.js'

interface Deps {
  serverUrl: string
  authedFetch: FetchLike
  write: WriteClient
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080'

export function App(): JSX.Element {
  const auth = useSteerAuth()
  if (auth.isLoading) return <div className="placeholder">connecting…</div>
  if (!auth.isAuthed) return <LoginGate auth={auth} />
  return <AuthedApp auth={auth} />
}

function LoginGate({ auth }: { auth: SteerAuth }): JSX.Element {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') await auth.login(email, password)
      else await auth.signup(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
      setBusy(false)
    }
  }

  return (
    <div className="placeholder">
      <form className="ph-card auth-form" onSubmit={submit}>
        <h2>steer</h2>
        <p>Watch a coding agent work — and steer it live.</p>
        <input
          className="auth-input"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="auth-input"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
        {error && <p className="auth-error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          className="auth-switch"
          type="button"
          onClick={() => {
            setMode((m) => (m === 'login' ? 'signup' : 'login'))
            setError(null)
          }}
        >
          {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  )
}

function AuthedApp({ auth }: { auth: SteerAuth }): JSX.Element {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterId>('all')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  // Reflect the theme on <html> and persist it so a refresh keeps the choice.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    storeTheme(theme)
  }, [theme])

  const authedFetch = useMemo(() => createAuthedFetch(auth.getToken, fetch), [auth])
  const write = useMemo(
    () => createWriteClient({ serverUrl: SERVER_URL, fetchImpl: authedFetch }),
    [authedFetch],
  )
  const deps: Deps = useMemo(
    () => ({ serverUrl: SERVER_URL, authedFetch, write }),
    [authedFetch, write],
  )
  const sessions = useMemo(() => createSessionsCollection(deps), [deps])
  const envCollection = useMemo(() => createEnvironmentsCollection(deps), [deps])

  // The Electric/TanStack live read + optimistic mutators are the external-SDK
  // boundary; cast locally so the rest of the app stays strictly typed.
  const live = useLiveQuery((q) => q.from({ s: sessions })) as unknown as { data?: SessionRow[] }
  const envLive = useLiveQuery((q) => q.from({ e: envCollection })) as unknown as { data?: EnvironmentRow[] }
  const mutate = sessions as unknown as {
    insert: (row: SessionRow) => void
    update: (key: string, updater: (draft: SessionRow) => void) => void
    delete: (key: string) => void
  }

  // Electric delivers snake_case columns; decode to the app's strict camelCase
  // shape before projecting (raw synced rows otherwise have undefined lastStatus).
  const rows = ((live.data ?? []) as unknown as Record<string, unknown>[]).map(decodeSessionRow)
  const environmentRows = ((envLive.data ?? []) as unknown as Record<string, unknown>[]).map(decodeEnvironmentRow)
  const views: SessionView[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    task: r.task,
    lastStatus: r.lastStatus,
    model: r.model,
    environment: r.environment,
    updatedAt: new Date(r.updatedAt).getTime(),
  }))

  const createSession = (value: { task: string; model: string; environment?: string; workdir?: string }): void => {
    const id = randomId('sess')
    const title = value.task.length > 42 ? `${value.task.slice(0, 40).trim()}…` : value.task
    const now = new Date().toISOString()
    mutate.insert({
      id,
      userId: '',
      title,
      task: value.task,
      lastStatus: 'starting',
      model: value.model,
      environment: value.environment ?? null,
      workdir: value.workdir ?? null,
      createdAt: now,
      updatedAt: now,
    })
    // Persist the last-used environment as a sticky default (only on successful insert).
    // Find the matching environment row to persist the *id* (not the env value).
    if (value.environment) {
      const matchRow = environmentRows.find((e) => e.env === value.environment)
      if (matchRow) {
        try { localStorage.setItem('steer_default_env', matchRow.id) } catch { /* private mode */ }
      }
    } else {
      try { localStorage.removeItem('steer_default_env') } catch { /* private mode */ }
    }
    setNewOpen(false)
    setActiveId(id)
  }

  const confirmTarget = views.find((s) => s.id === confirmId) ?? null
  const activeView = views.find((s) => s.id === activeId) ?? null

  return (
    <>
      <Shell
        userEmail={auth.email}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onLogout={() => void performLogout(auth.signOut, () => location.reload(), location.origin)}
        sidebar={
          <Sidebar
            sessions={views}
            activeId={activeId}
            query={query}
            filter={filter}
            now={Date.now()}
            onQuery={setQuery}
            onFilter={setFilter}
            onOpen={setActiveId}
            onNew={() => setNewOpen(true)}
            onRename={(id, title) => mutate.update(id, (d) => (d.title = title))}
            onDelete={setConfirmId}
          />
        }
        main={
          activeView ? (
            <DetailPane key={activeView.id} session={activeView} deps={deps} write={write} />
          ) : (
            <div className="main">
              <div className="placeholder">
                <div className="ph-card">
                  <h2>No session selected</h2>
                  <p>Pick a session from the left, or start a new one. The agent streams its work here — step into any tool call to intercept it live.</p>
                </div>
              </div>
            </div>
          )
        }
      />
      {newOpen && (
        <NewSessionModal
          onClose={() => setNewOpen(false)}
          onCreate={createSession}
          environments={environmentRows}
          defaultEnvironment={(() => { try { return localStorage.getItem('steer_default_env') } catch { return null } })()}
        />
      )}
      {confirmTarget && (
        <ConfirmModal
          title="Delete session?"
          message={`“${confirmTarget.title}” and its trace will be removed.`}
          onClose={() => setConfirmId(null)}
          onConfirm={() => {
            mutate.delete(confirmTarget.id)
            if (activeId === confirmTarget.id) setActiveId(null)
            setConfirmId(null)
          }}
        />
      )}
    </>
  )
}

function DetailPane({ session, deps, write }: { session: SessionView; deps: Deps; write: WriteClient }): JSX.Element {
  const events = useMemo(() => createEventsCollection(deps, session.id), [deps, session.id])
  const live = useLiveQuery((q) => q.from({ e: events })) as unknown as { data?: EventRow[] }
  // Decode Electric's wire format: snake_case keys, stringified seq, jsonb-as-string payload.
  const rows = ((live.data ?? []) as unknown as Record<string, unknown>[]).map(decodeEventRow)
  const rawEvents = rows.map((r) => ({ seq: r.seq, type: r.type, payload: r.payload }))
  const items = buildTrace(rawEvents, session.task)
  const plan = latestPlan(rawEvents)

  const handleAction = (tool: ToolItem, action: InterceptAction): void => {
    const id = tool.toolCallId
    if (action.type === 'approve') void write.sendControl(session.id, 'approve', { toolCallId: id })
    else if (action.type === 'reject') void write.sendControl(session.id, 'reject', { toolCallId: id })
    else if (action.type === 'swap')
      void write.sendControl(session.id, 'override', { toolCallId: id, newTool: action.newTool })
    else void write.sendControl(session.id, 'override', { toolCallId: id, newArgs: action.newArgs })
  }

  const handleSendMessage = async (text: string): Promise<void> => {
    await write.sendMessage(session.id, text)
  }

  return (
    <SessionDetail
      title={session.title}
      model={session.model}
      status={session.lastStatus}
      environment={session.environment ?? null}
      items={items}
      plan={plan}
      onInterrupt={() => void write.sendControl(session.id, 'interrupt', {})}
      onContinue={() => void write.setStatus(session.id, 'starting')}
      onSendMessage={handleSendMessage}
      renderToolControls={(tool) => <InterceptControls tool={tool} onAction={(a) => handleAction(tool, a)} />}
    />
  )
}
