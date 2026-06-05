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

  it('places Interrupt in the composer next to Send while live', () => {
    setup('running')
    const composer = screen.getByText('Send').closest('.composer')
    expect(composer).not.toBeNull()
    // Interrupt is co-located with Send in the composer, not in the header actions.
    expect(composer).toContainElement(screen.getByText('Interrupt'))
    expect(screen.getByText('Interrupt').closest('.dh-actions')).toBeNull()
  })

  it('hides Interrupt from the composer when not live', () => {
    setup('completed')
    expect(screen.queryByText('Interrupt')).not.toBeInTheDocument()
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

  it('shows the environment badge when the session is routed', () => {
    setup('running', { environment: 'laptop' })
    expect(screen.getByText('env: laptop')).toBeInTheDocument()
  })

  it('omits the environment badge for an unrouted session', () => {
    setup('running')
    expect(screen.queryByText(/^env:/)).not.toBeInTheDocument()
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

  describe('composer', () => {
    it('renders the composer textarea and Send button', () => {
      setup('completed')
      expect(screen.getByPlaceholderText('Send a follow-up instruction…')).toBeInTheDocument()
      expect(screen.getByText('Send')).toBeInTheDocument()
    })

    it('disables the composer when the session is running', () => {
      setup('running')
      const textarea = screen.getByPlaceholderText('Interrupt the session first')
      expect(textarea).toBeDisabled()
      expect(screen.getByText('Send')).toBeDisabled()
    })

    it('disables the composer when the session is starting', () => {
      setup('starting')
      expect(screen.getByPlaceholderText('Interrupt the session first')).toBeDisabled()
      expect(screen.getByText('Send')).toBeDisabled()
    })

    it('disables the composer when the session is awaiting-approval', () => {
      setup('awaiting-approval')
      expect(screen.getByPlaceholderText('Interrupt the session first')).toBeDisabled()
      expect(screen.getByText('Send')).toBeDisabled()
    })

    it('disables Send when text is blank', () => {
      setup('completed')
      expect(screen.getByText('Send')).toBeDisabled()
    })

    it('calls onSendMessage with trimmed text and clears the textarea on success', async () => {
      const onSendMessage = vi.fn(async () => {})
      setup('completed', { onSendMessage })
      const textarea = screen.getByPlaceholderText('Send a follow-up instruction…') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: '  now add tests  ' } })
      expect(screen.getByText('Send')).not.toBeDisabled()
      fireEvent.click(screen.getByText('Send'))
      await vi.waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('now add tests'))
      // textarea is cleared after success
      await vi.waitFor(() => expect(textarea.value).toBe(''))
    })

    it('is visible alongside Continue for interrupted sessions', () => {
      setup('interrupted')
      expect(screen.getByText('Continue')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Send a follow-up instruction…')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Send a follow-up instruction…')).not.toBeDisabled()
    })
  })
})
