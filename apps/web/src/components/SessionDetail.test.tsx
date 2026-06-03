import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionDetail, type SessionDetailProps } from './SessionDetail.js'
import type { TraceItem } from '../lib/trace.js'
import type { SessionStatus } from '@steer/schema'

const items: TraceItem[] = [
  { kind: 'message', key: 'm0', text: 'I will search' },
  {
    kind: 'tool',
    key: 'tool-tc1',
    toolCallId: 'tc1',
    name: 'grep',
    toolKind: 'read-only',
    args: { pattern: 'login' },
    status: 'running',
    result: null,
    substitutedFrom: null,
  },
]

function setup(status: SessionStatus, over: Partial<SessionDetailProps> = {}): SessionDetailProps {
  const props: SessionDetailProps = {
    title: 'Add auth',
    model: 'sonnet',
    status,
    items,
    onInterrupt: vi.fn(),
    onContinue: vi.fn(),
    ...over,
  }
  render(<SessionDetail {...props} />)
  return props
}

describe('SessionDetail', () => {
  it('renders the trace (messages + tool cards)', () => {
    setup('running')
    expect(screen.getByText('I will search')).toBeInTheDocument()
    expect(screen.getByText('grep')).toBeInTheDocument()
    expect(screen.getByTestId('tool-tc1')).toBeInTheDocument()
  })

  it('shows Interrupt while live and fires the callback', () => {
    const p = setup('running')
    const btn = screen.getByText('Interrupt')
    fireEvent.click(btn)
    expect(p.onInterrupt).toHaveBeenCalled()
    expect(screen.queryByText('Continue')).not.toBeInTheDocument()
  })

  it('shows Continue when interrupted and fires the callback', () => {
    const p = setup('interrupted')
    fireEvent.click(screen.getByText('Continue'))
    expect(p.onContinue).toHaveBeenCalled()
    expect(screen.queryByText('Interrupt')).not.toBeInTheDocument()
  })

  it('renders injected tool controls when provided', () => {
    setup('running', { renderToolControls: () => <button>Intervene</button> })
    expect(screen.getByText('Intervene')).toBeInTheDocument()
  })
})
