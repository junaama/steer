import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ToolCard } from './ToolCard.js'
import type { ToolItem } from '../lib/trace.js'

function tool(over: Partial<ToolItem>): ToolItem {
  return {
    kind: 'tool',
    key: 'tool-tc1',
    toolCallId: 'tc1',
    name: 'grep',
    toolKind: 'read-only',
    args: {},
    status: 'done',
    result: null,
    substitutedFrom: null,
    ...over,
  }
}

describe('ToolCard', () => {
  it('renders a diff for a file-writing tool', () => {
    render(
      <ToolCard
        tool={tool({
          name: 'write_file',
          toolKind: 'side-effecting',
          status: 'pending',
          args: { path: 'src/login.ts' },
          before: 'return null',
          after: 'return session',
        })}
      />,
    )
    const diff = screen.getByTestId('diff')
    expect(diff).toBeInTheDocument()
    expect(within(diff).getByText('return null')).toBeInTheDocument()
    expect(within(diff).getByText('return session')).toBeInTheDocument()
    expect(within(diff).getByText('src/login.ts')).toBeInTheDocument()
  })

  it('renders a result block (not a diff) for non-file tools', () => {
    render(<ToolCard tool={tool({ name: 'grep', status: 'done', result: 'a match', args: { pattern: 'x' } })} />)
    expect(screen.queryByTestId('diff')).not.toBeInTheDocument()
    expect(screen.getByText('a match')).toBeInTheDocument()
  })

  it('shows the substitution audit', () => {
    render(<ToolCard tool={tool({ name: 'read', substitutedFrom: 'grep', status: 'substituted', result: 'r' })} />)
    expect(screen.getByText(/operator substituted/)).toBeInTheDocument()
  })

  it('shows the edited-arguments audit line when editedArgs is set', () => {
    render(<ToolCard tool={tool({ name: 'read_file', status: 'done', result: 'r', editedArgs: true })} />)
    expect(screen.getByText('operator edited arguments before running')).toBeInTheDocument()
  })

  it('omits the edited-arguments audit line by default', () => {
    render(<ToolCard tool={tool({ name: 'grep', status: 'done', result: 'r' })} />)
    expect(screen.queryByText('operator edited arguments before running')).not.toBeInTheDocument()
  })

  it('handles a tool with no args', () => {
    render(<ToolCard tool={tool({ name: 'list_dir', status: 'running', args: {} })} />)
    expect(screen.getByText('list_dir')).toBeInTheDocument()
  })

  it('summarizes multiple args with a +N indicator', () => {
    render(<ToolCard tool={tool({ name: 'grep', status: 'running', args: { pattern: 'x', path: 'src/', flags: '-rn' } })} />)
    expect(screen.getByText(/\+2/)).toBeInTheDocument()
  })

  it('labels the outcome for a completed write', () => {
    render(
      <ToolCard
        tool={tool({
          name: 'write_file',
          toolKind: 'side-effecting',
          status: 'done',
          args: { path: 'a' },
          before: 'x',
          after: 'y',
          result: 'Wrote a',
        })}
      />,
    )
    expect(screen.getByText('Outcome')).toBeInTheDocument()
    expect(screen.getByText('Wrote a')).toBeInTheDocument()
  })
})
