import type { PlanItem } from '../lib/trace.js'

const STATUS_LABEL: Record<PlanItem['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  done: 'done',
}

export function TodoPanel({ items }: { items: readonly PlanItem[] | null }): JSX.Element | null {
  if (!items || items.length === 0) return null

  return (
    <aside className="todo-panel" aria-label="Todo list">
      <div className="todo-head">
        <span className="eyebrow">Plan</span>
        <span className="todo-count">{items.length}</span>
      </div>
      <ol className="todo-list">
        {items.map((item, index) => (
          <li className="todo-item" data-status={item.status} key={`${index}-${item.text}`}>
            <span className="todo-mark" aria-hidden="true" />
            <span className="todo-text">{item.text}</span>
            <span className="todo-status">{STATUS_LABEL[item.status]}</span>
          </li>
        ))}
      </ol>
    </aside>
  )
}
