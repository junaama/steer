import { useMemo, useState, useEffect } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { Shell } from './components/Shell.js'
import { Sidebar } from './components/Sidebar.js'
import { NewSessionModal } from './components/NewSessionModal.js'
import { ConfirmModal } from './components/ConfirmModal.js'
import { useSteerAuth, type SteerAuth } from './auth/AuthProvider.js'
import { createAuthedFetch, performLogout } from './auth/authed-fetch.js'
import { createWriteClient } from './lib/write-client.js'
import { createSessionsCollection } from './data/electric.js'
import { randomId } from './lib/id.js'
import type { SessionView, FilterId } from './lib/filter.js'
import type { SessionRow } from './data/types.js'

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
  const sessions = useMemo(
    () => createSessionsCollection({ serverUrl: SERVER_URL, authedFetch, write }),
    [authedFetch, write],
  )

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
          <div className="main">
            <div className="placeholder">
              <div className="ph-card">
                <h2>{activeId ? 'Session ready' : 'No session selected'}</h2>
                <p>The live trace + interception view lands here (U7). Pick or start a session.</p>
              </div>
            </div>
          </div>
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
