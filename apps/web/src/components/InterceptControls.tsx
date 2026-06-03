import { useState } from 'react'
import type { ToolItem } from '../lib/trace.js'
import { SwapPicker } from './SwapPicker.js'
import { ArgEditor } from './ArgEditor.js'

export type InterceptAction =
  | { type: 'approve' }
  | { type: 'reject' }
  | { type: 'swap'; newTool: string }
  | { type: 'edit'; newArgs: Record<string, unknown> }

export interface InterceptControlsProps {
  tool: ToolItem
  onAction: (action: InterceptAction) => void
}

export function InterceptControls({ tool, onAction }: InterceptControlsProps): JSX.Element | null {
  const [mode, setMode] = useState<'view' | 'swap' | 'edit'>('view')
  const pending = tool.status === 'pending'
  const running = tool.status === 'running'
  if (!pending && !running) return null

  const close = (): void => setMode('view')

  return (
    <div className="intercept">
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        {pending ? 'Will not run until you act' : 'Read-only · intervene live'}
      </div>

      {mode === 'view' && (
        <div className="ic-actions">
          {pending ? (
            <>
              <button className="btn sm primary" onClick={() => onAction({ type: 'approve' })}>
                Approve
              </button>
              <button className="btn sm" onClick={() => setMode('swap')}>
                Swap → read-only
              </button>
              <button className="btn sm" onClick={() => setMode('edit')}>
                Edit args
              </button>
              <button className="btn sm danger" onClick={() => onAction({ type: 'reject' })}>
                Reject
              </button>
            </>
          ) : (
            <>
              <button className="btn sm" onClick={() => setMode('swap')}>
                Cancel &amp; swap → read
              </button>
              <button className="btn sm" onClick={() => setMode('edit')}>
                Edit args
              </button>
              <button className="btn sm danger" onClick={() => onAction({ type: 'reject' })}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {mode === 'swap' && (
        <SwapPicker
          current={tool.name}
          onClose={close}
          onPick={(newTool) => {
            onAction({ type: 'swap', newTool })
            close()
          }}
        />
      )}
      {mode === 'edit' && (
        <ArgEditor
          args={tool.args}
          onClose={close}
          onSubmit={(newArgs) => {
            onAction({ type: 'edit', newArgs })
            close()
          }}
        />
      )}
    </div>
  )
}
