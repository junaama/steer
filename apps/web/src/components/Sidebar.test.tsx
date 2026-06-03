import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar, type SidebarProps } from './Sidebar.js'
import type { SessionView } from '../lib/filter.js'

const sessions: SessionView[] = [
  { id: '1', title: 'Add auth', lastStatus: 'running', model: 'sonnet', updatedAt: 0 },
  { id: '2', title: 'Fix checkout', lastStatus: 'completed', model: 'sonnet', updatedAt: 0 },
]

function setup(over: Partial<SidebarProps> = {}): SidebarProps {
  const props: SidebarProps = {
    sessions,
    activeId: null,
    query: '',
    filter: 'all',
    now: 1000,
    onQuery: vi.fn(),
    onFilter: vi.fn(),
    onOpen: vi.fn(),
    onNew: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  }
  render(<Sidebar {...props} />)
  return props
}

describe('Sidebar', () => {
  it('renders all sessions', () => {
    setup()
    expect(screen.getByText('Add auth')).toBeInTheDocument()
    expect(screen.getByText('Fix checkout')).toBeInTheDocument()
  })

  it('applies the query filter', () => {
    setup({ query: 'auth' })
    expect(screen.getByText('Add auth')).toBeInTheDocument()
    expect(screen.queryByText('Fix checkout')).not.toBeInTheDocument()
  })

  it('shows the empty state when nothing matches', () => {
    setup({ query: 'zzz' })
    expect(screen.getByText('No sessions match')).toBeInTheDocument()
  })

  it('shows "No sessions yet" when the list is empty with no query', () => {
    setup({ sessions: [] })
    expect(screen.getByText('No sessions yet')).toBeInTheDocument()
  })

  it('marks the active row', () => {
    setup({ activeId: '1' })
    expect(screen.getByText('Add auth').closest('.srow')).toHaveAttribute('data-active', 'true')
  })

  it('fires onQuery while typing', () => {
    const p = setup()
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'x' } })
    expect(p.onQuery).toHaveBeenCalledWith('x')
  })

  it('fires onFilter when a filter chip is clicked', () => {
    const p = setup()
    fireEvent.click(screen.getByText('Live'))
    expect(p.onFilter).toHaveBeenCalledWith('running')
  })

  it('wires open / new / delete callbacks', () => {
    const p = setup()
    fireEvent.click(screen.getByText('New session'))
    expect(p.onNew).toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Delete Add auth'))
    expect(p.onDelete).toHaveBeenCalledWith('1')
    fireEvent.click(screen.getByText('Add auth'))
    expect(p.onOpen).toHaveBeenCalledWith('1')
  })
})
