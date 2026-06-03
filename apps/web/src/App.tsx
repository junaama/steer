import { useMemo, useState, useEffect } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { Shell } from './components/Shell.js'
import { Sidebar } from './components/Sidebar.js'
import { SessionDetail } from './components/SessionDetail.js'
import { NewSessionModal } from './components/NewSessionModal.js'
import { ConfirmModal } from './components/ConfirmModal.js'
import { useSteerAuth, type SteerAuth } from './auth/AuthProvider.js'
import { createAuthedFetch, performLogout, type FetchLike } from './auth/authed-fetch.js'
import { createWriteClient, type WriteClient } from './lib/write-client.js'
import { createSessionsCollection, createEventsCollection } from './data/electric.js'
import { buildTrace } from './lib/trace.js'
import { randomId } from './lib/id.js'
import type { SessionView, FilterId } from './lib/filter.js'
import type { SessionRow, EventRow } from './data/types.js'

interface Deps {
  serverUrl: string
  authedFetch: FetchLike
  write: WriteClient
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080'

export function App(): JSX.Element {
  const auth = useSteerAuth()
  if (auth.isLoading) return <div className="placeholder">connecting…</div>
  if (!auth.isAuthed) return <LoginGate onSignIn={auth.signIn} />
  return <AuthedApp auth={auth} />
}

function LoginGate({ onSignIn }: { onSignIn: () => void }): JSX.Element {
  return (
    <div className="placeholder">
      <div className="ph-card">
        <h2>steer</h2>
        <p>Watch a coding agent work — and steer it live. Sign in to continue.</p>
        <button className="btn primary" onClick={onSignIn}>
          Sign in
        </button>
      </div>
    </div>
  )
}

function AuthedApp({ auth }: { auth: SteerAuth }): JSX.Element {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterId>('all')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
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

  // The Electric/TanStack live read + optimistic mutators are the external-SDK
  // boundary; cast locally so the rest of the app stays strictly typed.
  const live = useLiveQuery((q) => q.from({ s: sessions })) as unknown as { data?: SessionRow[] }
  const mutate = sessions as unknown as {
    insert: (row: SessionRow) => void
    delete: (key: string) => void
  }

  const rows = live.data ?? []
  const views: SessionView[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    lastStatus: r.lastStatus,
    model: r.model,
    updatedAt: new Date(r.updatedAt).getTime(),
  }))

  const createSession = (value: { task: string; model: string }): void => {
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
      createdAt: now,
      updatedAt: now,
    })
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
      {newOpen && <NewSessionModal onClose={() => setNewOpen(false)} onCreate={createSession} />}
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
  const rows = live.data ?? []
  const items = buildTrace(rows.map((r) => ({ seq: r.seq, type: r.type, payload: r.payload })))
  return (
    <SessionDetail
      title={session.title}
      model={session.model}
      status={session.lastStatus}
      items={items}
      onInterrupt={() => void write.sendControl(session.id, 'interrupt', {})}
      onContinue={() => void write.setStatus(session.id, 'starting')}
    />
  )
}
