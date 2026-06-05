import { useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from '../src/components/Shell.js'
import { Sidebar } from '../src/components/Sidebar.js'
import { SessionDetail } from '../src/components/SessionDetail.js'
import { InterceptControls } from '../src/components/InterceptControls.js'
import { buildTrace, type RawEvent } from '../src/lib/trace.js'
import type { SessionView } from '../src/lib/filter.js'
import '../src/styles.css'

/**
 * E2E harness: mounts the REAL Sidebar / SessionDetail / InterceptControls driven
 * by a store that syncs across browser tabs via BroadcastChannel — a deterministic
 * stand-in for Electric so the two-window UX can be tested with no external
 * services. The production Electric wiring is exercised by `docker compose up`.
 */

interface State {
  sessions: SessionView[]
  events: Record<string, RawEvent[]>
}

const KEY = 'steer-e2e'
const channel = new BroadcastChannel('steer-e2e')
const load = (): State => JSON.parse(localStorage.getItem(KEY) ?? '{"sessions":[],"events":{}}') as State
const save = (s: State): void => {
  localStorage.setItem(KEY, JSON.stringify(s))
  channel.postMessage('changed')
}

function Harness(): JSX.Element {
  const [state, setState] = useState<State>(load)
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    const onChange = (): void => setState(load())
    channel.addEventListener('message', onChange)
    window.addEventListener('storage', onChange)
    return () => {
      channel.removeEventListener('message', onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])

  const mutate = useCallback((fn: (s: State) => State): void => {
    const next = fn(load())
    save(next)
    setState(next)
  }, [])

  const createSession = (): void => {
    const id = `sess-${Math.random().toString(36).slice(2, 8)}`
    const session: SessionView = { id, title: 'Build the thing', lastStatus: 'awaiting-approval', model: 'sonnet', updatedAt: Date.now() }
    const events: RawEvent[] = [
      { seq: 0, type: 'message', payload: { text: 'I will update the login handler.' } },
      {
        seq: 1,
        type: 'tool_proposed',
        payload: { toolCallId: 'tc1', name: 'write_file', kind: 'side-effecting', args: { path: 'src/login.ts' }, before: 'return null', after: 'return session' },
      },
    ]
    mutate((s) => ({ sessions: [session, ...s.sessions], events: { ...s.events, [id]: events } }))
    setActiveId(id)
  }

  const approve = (sessionId: string, toolCallId: string): void => {
    mutate((s) => {
      const evs = s.events[sessionId] ?? []
      const next: RawEvent[] = [
        ...evs,
        { seq: evs.length, type: 'tool_result', payload: { toolCallId, name: 'write_file', result: 'Wrote src/login.ts · +1 −1' } },
      ]
      return {
        sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, lastStatus: 'completed' } : x)),
        events: { ...s.events, [sessionId]: next },
      }
    })
  }

  // Append one synced event to a session — the unit the streaming scenario uses to
  // grow the live transcript a chunk at a time (each append re-syncs to window B).
  const appendEvent = (sessionId: string, type: RawEvent['type'], payload: Record<string, unknown>): void => {
    mutate((s) => {
      const evs = s.events[sessionId] ?? []
      return { ...s, events: { ...s.events, [sessionId]: [...evs, { seq: evs.length, type, payload }] } }
    })
  }

  /**
   * Drive a session through the live-streaming + diff-review experience the U11
   * capstone proves end-to-end: stream assistant text as coarse `message_delta`
   * rows that arrive over time (so the transcript fills in incrementally, synced
   * live to the other window), then propose a reviewable file-edit diff that the
   * operator approves. Uses the SAME real Sidebar/SessionDetail/ToolCard/DiffView
   * the production app renders — only the store is a BroadcastChannel stand-in for
   * Electric (mirrors the existing two-window harness exactly).
   */
  const streamSession = (): void => {
    const id = `stream-${Math.random().toString(36).slice(2, 8)}`
    const session: SessionView = { id, title: 'Stream the fix', lastStatus: 'running', model: 'sonnet', updatedAt: Date.now() }
    mutate((s) => ({ sessions: [session, ...s.sessions], events: { ...s.events, [id]: [] } }))
    setActiveId(id)

    // Stream the reply in coarse chunks, one per tick — each is a `message_delta`
    // row that folds into the one growing message item (buildTrace), so the text
    // visibly fills in. After the last chunk, propose the reviewable diff.
    const chunks = ['Updating ', 'the login ', 'handler now.']
    chunks.forEach((chunk, i) => {
      setTimeout(() => appendEvent(id, 'message_delta', { text: chunk }), 80 * (i + 1))
    })
    setTimeout(() => {
      appendEvent(id, 'tool_proposed', {
        toolCallId: 'sc1',
        name: 'write_file',
        kind: 'side-effecting',
        args: { path: 'src/login.ts' },
        before: 'return null',
        after: 'return session',
      })
      mutate((s) => ({ ...s, sessions: s.sessions.map((x) => (x.id === id ? { ...x, lastStatus: 'awaiting-approval' } : x)) }))
    }, 80 * (chunks.length + 1))
  }

  const active = state.sessions.find((x) => x.id === activeId) ?? null

  return (
    <>
    <div style={{ position: 'fixed', top: 4, right: 4, zIndex: 1000 }}>
      <button onClick={streamSession}>Stream session</button>
    </div>
    <Shell
      userEmail="e2e@steer.dev"
      theme="dark"
      onToggleTheme={() => undefined}
      onLogout={() => undefined}
      sidebar={
        <Sidebar
          sessions={state.sessions}
          activeId={activeId}
          query=""
          filter="all"
          now={Date.now()}
          onQuery={() => undefined}
          onFilter={() => undefined}
          onOpen={setActiveId}
          onNew={createSession}
          onDelete={() => undefined}
        />
      }
      main={
        active ? (
          <SessionDetail
            title={active.title}
            model={active.model}
            status={active.lastStatus}
            items={buildTrace(state.events[active.id] ?? [])}
            onInterrupt={() => undefined}
            onContinue={() => undefined}
            renderToolControls={(toolItem) => (
              <InterceptControls
                tool={toolItem}
                onAction={(a) => {
                  if (a.type === 'approve') approve(active.id, toolItem.toolCallId)
                }}
              />
            )}
          />
        ) : (
          <div className="main">
            <div className="placeholder">
              <div className="ph-card">
                <h2>No session selected</h2>
              </div>
            </div>
          </div>
        )
      }
    />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
