import type { ToolStatus } from '@steer/schema'
import { TOOL_STATUS_META } from '../lib/design.js'

export function StatBadge({ status }: { status: ToolStatus }): JSX.Element {
  const meta = TOOL_STATUS_META[status]
  return (
    <span className="statbadge" style={{ color: meta.color, borderColor: meta.color }}>
      <span className="dot" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}
