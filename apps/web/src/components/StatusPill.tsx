import type { SessionStatus } from '@steer/schema'
import { SESSION_STATUS_META } from '../lib/design.js'

export function StatusPill({ status }: { status: SessionStatus }): JSX.Element {
  const meta = SESSION_STATUS_META[status]
  return (
    <span className="statuspill" style={{ color: meta.color, borderColor: meta.color }}>
      <span className="dot" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}
