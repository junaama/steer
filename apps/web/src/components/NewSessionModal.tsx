import { useState } from 'react'
import type { ImageAttachment } from '@steer/schema'
import type { EnvironmentRow } from '../data/types.js'
import { readImageFile, toPreviewUrl, fromBrowserFile } from '../lib/image-attach.js'

/** Threshold (ms) for determining online/offline status from lastSeenAt. */
const STALE_THRESHOLD_MS = 60_000

export interface NewSessionModalProps {
  onClose: () => void
  onCreate: (value: {
    task: string
    model: string
    environment?: string
    workdir?: string
    /** An optional image attached to the initial task (R14, vision input). */
    image?: ImageAttachment
  }) => void
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
  const [image, setImage] = useState<ImageAttachment | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)

  const now = Date.now()

  // Read the chosen file into a validated, capped attachment; surface a clear
  // message on a non-image or over-cap file instead of silently failing (R14).
  const onPickImage = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const result = await readImageFile(fromBrowserFile(file))
    if (result.ok) {
      setImage(result.image)
      setImageError(null)
    } else {
      setImage(null)
      setImageError(result.error)
    }
  }

  const clearImage = (): void => {
    setImage(null)
    setImageError(null)
  }

  const submit = (): void => {
    if (!task.trim()) return
    const selectedRow = environments.find((e) => e.id === selectedEnvId)
    // When "Default (unrouted)" is selected or no match, environment is undefined (omitted from payload).
    // When a named environment is selected, use its `env` value (which may be null for the default daemon).
    const environment = selectedRow ? (selectedRow.env ?? undefined) : undefined
    const trimmedWorkdir = workdir.trim() || undefined
    onCreate({ task: task.trim(), model, environment, workdir: trimmedWorkdir, image: image ?? undefined })
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
          <div className="opt-row">
            <span className="eyebrow">Image</span>
            <input
              className="image-input"
              type="file"
              accept="image/*"
              aria-label="Attach image"
              onChange={(e) => void onPickImage(e.target.files?.[0])}
            />
          </div>
          {imageError && (
            <div className="image-error" role="alert">
              {imageError}
            </div>
          )}
          {image && (
            <div className="image-preview">
              <img src={toPreviewUrl(image)} alt="Attached preview" />
              <button className="btn ghost" type="button" onClick={clearImage}>
                Remove image
              </button>
            </div>
          )}
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
