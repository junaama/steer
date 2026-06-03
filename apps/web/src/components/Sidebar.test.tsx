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
    onRename: vi.fn(),
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

  it('keeps the full title available when a long row title is visually truncated', () => {
    const longTitle = 'Say hello in one sentence. Do not modify files or run destructive commands.'

    setup({
      sessions: [{ id: 'long', title: longTitle, lastStatus: 'completed', model: 'sonnet', updatedAt: 0 }],
      activeId: 'long',
    })

    const title = screen.getByText(longTitle)
    expect(title).toHaveClass('s-title')
    expect(title).toHaveAttribute('title', longTitle)
    expect(title.closest('.srow')).toHaveAttribute('data-active', 'true')
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

  it('renames a session inline (edit → type → Enter) without opening it', () => {
    const p = setup()
    fireEvent.click(screen.getByLabelText('Rename Add auth')) // the edit button
    const input = screen.getByLabelText('New name for Add auth')
    fireEvent.click(input) // clicking the input must not open the session
    fireEvent.change(input, { target: { value: 'Auth v2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(p.onRename).toHaveBeenCalledWith('1', 'Auth v2')
    expect(p.onOpen).not.toHaveBeenCalled()
  })

  it('cancels a rename on Escape', () => {
    const p = setup()
    fireEvent.click(screen.getByLabelText('Rename Fix checkout'))
    const input = screen.getByLabelText('New name for Fix checkout')
    fireEvent.change(input, { target: { value: 'discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(p.onRename).not.toHaveBeenCalled()
  })

  it('does not rename when blank or unchanged (commit via blur / Enter)', () => {
    const p = setup()
    // blank → ignored (blur commit)
    fireEvent.click(screen.getByLabelText('Rename Add auth'))
    fireEvent.change(screen.getByLabelText('New name for Add auth'), { target: { value: '   ' } })
    fireEvent.blur(screen.getByLabelText('New name for Add auth'))
    // unchanged → ignored (Enter commit)
    fireEvent.click(screen.getByLabelText('Rename Fix checkout'))
    fireEvent.keyDown(screen.getByLabelText('New name for Fix checkout'), { key: 'Enter' })
    expect(p.onRename).not.toHaveBeenCalled()
  })

  it('ignores a row click while it is being edited', () => {
    const p = setup()
    fireEvent.click(screen.getByLabelText('Rename Add auth'))
    fireEvent.click(screen.getByLabelText('New name for Add auth').closest('.srow')!)
    expect(p.onOpen).not.toHaveBeenCalled()
  })

  it('renders the ⌘K hint in the search area', () => {
    setup()
    expect(screen.getByText('⌘K')).toBeInTheDocument()
  })

  it('focuses the search input on ⌘K (metaKey)', () => {
    setup()
    const input = screen.getByLabelText('Search sessions')
    expect(input).not.toBe(document.activeElement)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(input).toBe(document.activeElement)
  })

  it('focuses the search input on Ctrl+K (ctrlKey)', () => {
    setup()
    const input = screen.getByLabelText('Search sessions')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(input).toBe(document.activeElement)
  })

  it('ignores keystrokes that are not the ⌘K shortcut', () => {
    setup()
    const input = screen.getByLabelText('Search sessions')
    fireEvent.keyDown(window, { key: 'k' }) // no modifier
    fireEvent.keyDown(window, { key: 'j', metaKey: true }) // wrong key
    expect(input).not.toBe(document.activeElement)
  })

  it('removes the keydown listener on unmount (no focus after teardown)', () => {
    const { unmount } = render(
      <Sidebar
        sessions={sessions}
        activeId={null}
        query=""
        filter="all"
        now={1000}
        onQuery={vi.fn()}
        onFilter={vi.fn()}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    const input = screen.getByLabelText('Search sessions')
    unmount()
    // After unmount the listener is gone, so the shortcut can't refocus a removed input.
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(input).not.toBe(document.activeElement)
  })
})
