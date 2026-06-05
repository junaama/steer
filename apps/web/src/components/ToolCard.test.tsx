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
    // The diff code is syntax-highlighted, so `return` is wrapped in its own
    // token span; assert against the line's full text content rather than a
    // single text node.
    const codeText = within(diff)
      .getAllByText((_content, el) => el?.classList.contains('code') ?? false)
      .map((el) => el.textContent)
    expect(codeText).toContain('return null')
    expect(codeText).toContain('return session')
    expect(within(diff).getByText('src/login.ts')).toBeInTheDocument()
  })

  it('AE2: shows the proposed diff but no applied/result block until tool_result arrives', () => {
    // A side-effecting file edit, proposed but not yet approved/applied:
    // result is still null, so the file is shown as a *proposal*, not applied.
    const proposed = tool({
      name: 'write_file',
      toolKind: 'side-effecting',
      status: 'pending',
      args: { path: 'src/login.ts' },
      before: 'return null',
      after: 'return session',
      result: null,
    })
    const { rerender } = render(<ToolCard tool={proposed} />)
    expect(screen.getByTestId('diff')).toBeInTheDocument()
    expect(screen.getByText('Proposed change')).toBeInTheDocument()
    // not applied yet: neither the Outcome label nor a result/stream block
    expect(screen.queryByText('Outcome')).not.toBeInTheDocument()
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-tc1-stream')).not.toBeInTheDocument()

    // tool_result arrives → the applied Outcome block appears alongside the diff
    rerender(<ToolCard tool={{ ...proposed, status: 'done', result: 'Wrote src/login.ts' }} />)
    expect(screen.getByText('Outcome')).toBeInTheDocument()
    expect(screen.getByText('Wrote src/login.ts')).toBeInTheDocument()
    expect(screen.getByTestId('diff')).toBeInTheDocument()
  })

  it('renders a result block (not a diff) for non-file tools', () => {
    render(<ToolCard tool={tool({ name: 'grep', status: 'done', result: 'a match', args: { pattern: 'x' } })} />)
    expect(screen.queryByTestId('diff')).not.toBeInTheDocument()
    expect(screen.getByText('a match')).toBeInTheDocument()
  })

  it('renders run_command output in a terminal block with its exit marker', () => {
    render(
      <ToolCard
        tool={tool({
          name: 'run_command',
          toolKind: 'side-effecting',
          status: 'done',
          result: 'failing test output\n[exit 1]',
          args: { command: 'pnpm test' },
        })}
      />,
    )

    const terminal = screen.getByTestId('run-command-result')
    expect(terminal.tagName).toBe('PRE')
    expect(terminal).toHaveTextContent('failing test output')
    expect(terminal).toHaveTextContent('[exit 1]')
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

  it('shows streaming stdout before the result arrives', () => {
    render(<ToolCard tool={tool({ name: 'run_command', status: 'running', result: null, streamingOutput: 'building…\n' })} />)
    const stream = screen.getByTestId('tool-tc1-stream')
    expect(stream).toHaveTextContent('building…')
    expect(screen.getByText('Output')).toBeInTheDocument()
  })

  it('hides the streaming block once the terminal result lands', () => {
    render(<ToolCard tool={tool({ name: 'grep', status: 'done', result: 'final output', streamingOutput: 'building…' })} />)
    expect(screen.queryByTestId('tool-tc1-stream')).not.toBeInTheDocument()
    expect(screen.getByText('final output')).toBeInTheDocument()
  })

  it('renders nested subagent children recursively', () => {
    render(
      <ToolCard
        tool={tool({
          name: 'task',
          toolKind: 'side-effecting',
          status: 'done',
          result: 'done',
          children: [
            { kind: 'thinking', key: 't-1', text: 'looking' },
            tool({
              key: 'tool-child-read',
              toolCallId: 'child-read',
              name: 'read_file',
              args: { path: 'a.txt' },
              result: 'hello',
            }),
          ],
        })}
      />,
    )

    const nested = screen.getByTestId('tool-tc1-children')
    expect(within(nested).getByText('Subagent')).toBeInTheDocument()
    expect(within(nested).getByText('looking')).toBeInTheDocument()
    expect(within(nested).getByTestId('tool-child-read')).toBeInTheDocument()
    expect(within(nested).getByText('hello')).toBeInTheDocument()
  })
})
