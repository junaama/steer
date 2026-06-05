import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QuestionPrompt } from './QuestionPrompt.js'

const question = { toolCallId: 'ask1', question: 'Which environment should I deploy to?' }

describe('QuestionPrompt', () => {
  it('renders the agent question and an answer input (R11, AE4)', () => {
    render(<QuestionPrompt question={question} onAnswer={vi.fn(async () => {})} />)
    expect(screen.getByText('Which environment should I deploy to?')).toBeInTheDocument()
    expect(screen.getByText('The agent is waiting on your answer')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Type your answer…')).toBeInTheDocument()
  })

  it('disables Answer until the operator types something', () => {
    render(<QuestionPrompt question={question} onAnswer={vi.fn(async () => {})} />)
    expect(screen.getByText('Answer')).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: 'production' } })
    expect(screen.getByText('Answer')).not.toBeDisabled()
  })

  it('submits the trimmed answer and clears the input on success', async () => {
    const onAnswer = vi.fn(async () => {})
    render(<QuestionPrompt question={question} onAnswer={onAnswer} />)
    const input = screen.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '  production  ' } })
    fireEvent.click(screen.getByText('Answer'))
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith('production'))
    await vi.waitFor(() => expect(input.value).toBe(''))
  })

  it('does not submit a blank (whitespace-only) answer', () => {
    const onAnswer = vi.fn(async () => {})
    render(<QuestionPrompt question={question} onAnswer={onAnswer} />)
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), { target: { value: '   ' } })
    // Answer stays disabled, so a click cannot fire onAnswer.
    expect(screen.getByText('Answer')).toBeDisabled()
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('keeps the input when the answer send rejects (no clear on failure)', async () => {
    const onAnswer = vi.fn(async () => {
      throw new Error('network')
    })
    render(<QuestionPrompt question={question} onAnswer={onAnswer} />)
    const input = screen.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'staging' } })
    fireEvent.click(screen.getByText('Answer'))
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalled())
    // The send failed, so the text is preserved for a retry.
    await vi.waitFor(() => expect(input.value).toBe('staging'))
  })
})
