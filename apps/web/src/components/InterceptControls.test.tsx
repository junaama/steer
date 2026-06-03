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

  it('submits edited args', () => {
    const onAction = vi.fn()
    const t = tool('pending', { name: 'write_file', toolKind: 'side-effecting', args: { path: 'a.ts' } })
    render(<InterceptControls tool={t} onAction={onAction} />)
    fireEvent.click(screen.getByText('Edit args'))
    fireEvent.change(screen.getByLabelText('path'), { target: { value: 'b.ts' } })
    fireEvent.click(screen.getByText('Run with edits'))
    expect(onAction).toHaveBeenCalledWith({ type: 'edit', newArgs: { path: 'b.ts' } })
  })
})
