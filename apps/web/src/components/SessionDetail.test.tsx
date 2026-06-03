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
    plan: null,
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

  it('renders a follow-up user_message with a "you" role label', () => {
    render(
      <SessionDetail
        title="t"
        model="sonnet"
        status="completed"
        items={[{ kind: 'user', key: 'u1', text: 'now add tests' }]}
        plan={null}
        onInterrupt={vi.fn()}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.getByText('now add tests')).toBeInTheDocument()
    expect(screen.getByText('you')).toBeInTheDocument()
    // the operator styling hinges on this class
    expect(screen.getByText('now add tests').closest('.ev-user')).toBeInTheDocument()
  })

  it('renders a thinking item with its role label', () => {
    render(
      <SessionDetail
        title="t"
        model="sonnet"
        status="completed"
        items={[{ kind: 'thinking', key: 't0', text: 'pondering' }]}
        plan={null}
        onInterrupt={vi.fn()}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.getByText('pondering')).toBeInTheDocument()
    expect(screen.getByText('thinking')).toBeInTheDocument()
  })

  it('pins the todo panel when a plan is present', () => {
    setup('running', {
      plan: [
        { text: 'write tests', status: 'pending' },
        { text: 'ship it', status: 'done' },
      ],
    })
    expect(screen.getByLabelText('Todo list')).toBeInTheDocument()
    expect(screen.getByText('write tests')).toBeInTheDocument()
    expect(screen.getByText('ship it')).toBeInTheDocument()
  })
})
