import { useState } from 'react'
import type { EnvironmentRow } from '../data/types.js'

/** Threshold (ms) for determining online/offline status from lastSeenAt. */
const STALE_THRESHOLD_MS = 60_000

export interface NewSessionModalProps {
  onClose: () => void
  onCreate: (value: { task: string; model: string; environment?: string; workdir?: string }) => void
  /** Registered environments from the synced collection. */
  environments: readonly EnvironmentRow[]
  /** Sticky default environment id from localStorage, if any. */
  defaultEnvironment?: string | null
}

const MODELS = ['sonnet', 'opus', 'haiku']

function isOnline(lastSeenAt: string, now: number): boolean {
  if (!lastSeenAt) return false
  const seen = new Date(lastSeenAt).getTime()
  return now - seen < STALE_THRESHOLD_MS
}

export function NewSessionModal({ onClose, onCreate, environments, defaultEnvironment }: NewSessionModalProps): JSX.Element {
  const [task, setTask] = useState('')
  const [model, setModel] = useState('sonnet')
  const [selectedEnvId, setSelectedEnvId] = useState<string>(defaultEnvironment ?? '__default__')
  const [workdir, setWorkdir] = useState('')

  const now = Date.now()

  const submit = (): void => {
    if (!task.trim()) return
    const selectedRow = environments.find((e) => e.id === selectedEnvId)
    // When "Default (unrouted)" is selected or no match, environment is undefined (omitted from payload).
    // When a named environment is selected, use its `env` value (which may be null for the default daemon).
    const environment = selectedRow ? (selectedRow.env ?? undefined) : undefined
    const trimmedWorkdir = workdir.trim() || undefined
    onCreate({ task: task.trim(), model, environment, workdir: trimmedWorkdir })
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>New session</h3>
        </div>
        <div className="modal-body">
          <textarea
            className="prompt-input"
            value={task}
            placeholder="What should we do?"
            aria-label="Task"
            onChange={(e) => setTask(e.target.value)}
          />
          <div className="opt-row">
            <span className="eyebrow">Model</span>
            {MODELS.map((m) => (
              <button key={m} className="opt" data-on={model === m} onClick={() => setModel(m)}>
                {m}
              </button>
            ))}
          </div>
          <div className="opt-row">
            <span className="eyebrow">Environment</span>
            <select
              className="env-select"
              value={selectedEnvId}
              aria-label="Environment"
              onChange={(e) => setSelectedEnvId(e.target.value)}
            >
              <option value="__default__">Default (unrouted)</option>
              {environments.map((env) => {
                const online = isOnline(env.lastSeenAt, now)
                return (
                  <option key={env.id} value={env.id}>
                    {online ? '●' : '○'} {env.id} ({env.host})
                  </option>
                )
              })}
            </select>
          </div>
          <div className="opt-row">
            <span className="eyebrow">Working dir</span>
            <input
              className="workdir-input"
              type="text"
              value={workdir}
              placeholder="/optional/working/directory"
              aria-label="Working directory"
              onChange={(e) => setWorkdir(e.target.value)}
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!task.trim()} onClick={submit}>
            Start session
          </button>
        </div>
      </div>
    </div>
  )
}
