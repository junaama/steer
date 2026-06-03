import type { SessionStatus } from '@steer/schema'
import { sessionStatusMeta } from '../lib/design.js'

export function StatusPill({ status }: { status: SessionStatus }): JSX.Element {
  const meta = sessionStatusMeta(status)
  return (
    <span className="statuspill" style={{ color: meta.color, borderColor: meta.color }}>
      <span className="dot" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}
