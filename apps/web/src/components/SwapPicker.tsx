import { READ_ONLY_TOOLS } from '@steer/schema'
import { Icon } from './Icon.js'

export function SwapPicker({
  current,
  onPick,
  onClose,
}: {
  current: string
  onPick: (name: string) => void
  onClose: () => void
}): JSX.Element {
  const options = READ_ONLY_TOOLS.filter((t) => t !== current)
  return (
    <div className="subpanel">
      <div className="sp-head">
        <span className="eyebrow">Substitute with a read-only tool</span>
        <button className="row-del" style={{ opacity: 1 }} aria-label="Close" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      {options.map((t) => (
        <div key={t} className="tool-opt" role="button" onClick={() => onPick(t)}>
          <div className="to-name">{t}</div>
        </div>
      ))}
    </div>
  )
}
