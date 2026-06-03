import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { TodoPanel } from './TodoPanel.js'
import type { PlanItem } from '../lib/trace.js'

const items: PlanItem[] = [
  { text: 'write tests', status: 'pending' },
  { text: 'implement tool', status: 'in_progress' },
  { text: 'verify coverage', status: 'done' },
]

describe('TodoPanel', () => {
  it('renders nothing when the plan is absent', () => {
    const { container } = render(<TodoPanel items={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the plan is empty', () => {
    const { container } = render(<TodoPanel items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders each todo item with distinct status labels and classes', () => {
    render(<TodoPanel items={items} />)
    const panel = screen.getByLabelText('Todo list')
    expect(within(panel).getByText('Plan')).toBeInTheDocument()
    expect(within(panel).getByText('3')).toBeInTheDocument()

    for (const item of items) {
      const row = within(panel).getByText(item.text).closest('.todo-item')
      expect(row).toBeInTheDocument()
      expect(row).toHaveAttribute('data-status', item.status)
    }

    expect(within(panel).getByText('pending')).toBeInTheDocument()
    expect(within(panel).getByText('in progress')).toBeInTheDocument()
    expect(within(panel).getByText('done')).toBeInTheDocument()
  })
})
