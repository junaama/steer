import type { ToolStatus } from '@steer/schema'
import { toolStatusMeta } from '../lib/design.js'

export function StatBadge({ status }: { status: ToolStatus }): JSX.Element {
  const meta = toolStatusMeta(status)
  return (
    <span className="statbadge" style={{ color: meta.color, borderColor: meta.color }}>
      <span className="dot" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}
