import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InterceptControls } from './InterceptControls.js'
import type { ToolItem } from '../lib/trace.js'

function tool(status: ToolItem['status'], over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool',
    key: 'tool-tc1',
    toolCallId: 'tc1',
    name: 'grep',
    toolKind: 'read-only',
    args: { pattern: 'login', path: 'src/' },
    status,
    result: null,
    substitutedFrom: null,
    ...over,
  }
}

describe('InterceptControls', () => {
  it('renders nothing for a non-interceptable tool', () => {
    const { container } = render(<InterceptControls tool={tool('done')} onAction={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows approve / swap / edit / reject for a pending side-effecting tool', () => {
    const onAction = vi.fn()
    const t = tool('pending', { name: 'write_file', toolKind: 'side-effecting', args: { path: 'a' } })
    render(<InterceptControls tool={t} onAction={onAction} />)
    fireEvent.click(screen.getByText('Approve'))
    expect(onAction).toHaveBeenCalledWith({ type: 'approve' })
    fireEvent.click(screen.getByText('Reject'))
    expect(onAction).toHaveBeenCalledWith({ type: 'reject' })
  })

  it('prompts diff-review and sends approve/reject for the proposal toolCallId', () => {
    // A side-effecting file edit carrying a before/after diff. Mirrors App.tsx:
    // onAction maps to sendControl(sessionId, kind, { toolCallId }), so we assert
    // the gate control is sent with THIS proposal's toolCallId.
    const sendControl = vi.fn()
    const t = tool('pending', {
      toolCallId: 'edit-7',
      name: 'write_file',
      toolKind: 'side-effecting',
      args: { path: 'src/auth.ts' },
      before: 'return null',
      after: 'return session',
    })
    const onAction = (action: { type: string }): void => {
      if (action.type === 'approve') sendControl('approve', { toolCallId: t.toolCallId })
      else if (action.type === 'reject') sendControl('reject', { toolCallId: t.toolCallId })
    }
    render(<InterceptControls tool={t} onAction={onAction} />)

    // diff-review prompt is shown for a proposal that carries a change
    expect(screen.getByText('Review the diff — applies only when you approve')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Approve'))
    expect(sendControl).toHaveBeenCalledWith('approve', { toolCallId: 'edit-7' })
    fireEvent.click(screen.getByText('Reject'))
    expect(sendControl).toHaveBeenCalledWith('reject', { toolCallId: 'edit-7' })
  })

  it('keeps the generic prompt for a pending tool with no proposed diff', () => {
    const t = tool('pending', { name: 'run_command', toolKind: 'side-effecting', args: { command: 'rm x' } })
    render(<InterceptControls tool={t} onAction={vi.fn()} />)
    expect(screen.getByText('Will not run until you act')).toBeInTheDocument()
    expect(screen.queryByText('Review the diff — applies only when you approve')).not.toBeInTheDocument()
  })

  it('shows cancel & swap / edit / cancel for a running read-only tool', () => {
    const onAction = vi.fn()
    render(<InterceptControls tool={tool('running')} onAction={onAction} />)
    expect(screen.getByText('Cancel & swap → read')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Cancel'))
    expect(onAction).toHaveBeenCalledWith({ type: 'reject' })
  })

  it('swap picker offers only read-only tools, excluding the current one', () => {
    const onAction = vi.fn()
    render(<InterceptControls tool={tool('running')} onAction={onAction} />)
    fireEvent.click(screen.getByText('Cancel & swap → read'))
    expect(screen.getByText('read_file')).toBeInTheDocument()
    expect(screen.queryByText('grep')).not.toBeInTheDocument() // current, excluded
    expect(screen.queryByText('write_file')).not.toBeInTheDocument() // side-effecting, excluded
    expect(screen.queryByText('bash')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('read_file'))
    expect(onAction).toHaveBeenCalledWith({ type: 'swap', newTool: 'read_file' })
  })

  it('opens the swap picker on a pending tool', () => {
    const t = tool('pending', { name: 'write_file', toolKind: 'side-effecting', args: { path: 'a' } })
    render(<InterceptControls tool={t} onAction={vi.fn()} />)
    fireEvent.click(screen.getByText('Swap → read-only'))
    expect(screen.getByText('read_file')).toBeInTheDocument()
  })

  it('opens the args editor on a running tool', () => {
    render(<InterceptControls tool={tool('running', { args: { path: 'a' } })} onAction={vi.fn()} />)
    fireEvent.click(screen.getByText('Edit args'))
    expect(screen.getByLabelText('path')).toBeInTheDocument()
  })

  it('submits edited args', () => {
    const onAction = vi.fn()
    const t = tool('pending', { name: 'write_file', toolKind: 'side-effecting', args: { path: 'a.ts' } })
    render(<InterceptControls tool={t} onAction={onAction} />)
    fireEvent.click(screen.getByText('Edit args'))
    fireEvent.change(screen.getByLabelText('path'), { target: { value: 'b.ts' } })
    fireEvent.click(screen.getByText('Run with edits'))
    expect(onAction).toHaveBeenCalledWith({ type: 'edit', newArgs: { path: 'b.ts' } })
  })

  it('uses a textarea for long argument values and can be closed', () => {
    const t = tool('pending', { name: 'write_file', toolKind: 'side-effecting', args: { content: 'x'.repeat(50) } })
    render(<InterceptControls tool={t} onAction={vi.fn()} />)
    fireEvent.click(screen.getByText('Edit args'))
    const ta = screen.getByLabelText('content')
    expect(ta.tagName).toBe('TEXTAREA')
    fireEvent.change(ta, { target: { value: 'z'.repeat(50) } })
    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByLabelText('content')).not.toBeInTheDocument()
  })
})
