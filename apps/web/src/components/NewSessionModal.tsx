import { useState } from 'react'

export interface NewSessionModalProps {
  onClose: () => void
  onCreate: (value: { task: string; model: string }) => void
}

const MODELS = ['sonnet', 'opus', 'haiku']

export function NewSessionModal({ onClose, onCreate }: NewSessionModalProps): JSX.Element {
  const [task, setTask] = useState('')
  const [model, setModel] = useState('sonnet')
  const submit = (): void => {
    if (task.trim()) onCreate({ task: task.trim(), model })
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
