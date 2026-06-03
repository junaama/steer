import { useState } from 'react'
import { Icon } from './Icon.js'

export function ArgEditor({
  args,
  onSubmit,
  onClose,
}: {
  args: Record<string, unknown>
  onSubmit: (next: Record<string, unknown>) => void
  onClose: () => void
}): JSX.Element {
  const keys = Object.keys(args)
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(keys.map((k) => [k, String(args[k])])),
  )
  return (
    <div className="subpanel">
      <div className="sp-head">
        <span className="eyebrow">Edit arguments</span>
        <button className="row-del" style={{ opacity: 1 }} aria-label="Close" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="argeditor">
        {keys.map((k) => (
          <div className="argfield" key={k}>
            <label htmlFor={`arg-${k}`}>{k}</label>
            {String(vals[k]).length > 38 ? (
              <textarea
                id={`arg-${k}`}
                rows={2}
                value={vals[k]}
                onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))}
              />
            ) : (
              <input
                id={`arg-${k}`}
                value={vals[k]}
                onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))}
              />
            )}
          </div>
        ))}
        <div className="flex" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn sm ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn sm primary" onClick={() => onSubmit(vals)}>
            Run with edits
          </button>
        </div>
      </div>
    </div>
  )
}
