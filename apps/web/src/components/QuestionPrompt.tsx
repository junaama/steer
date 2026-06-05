import { useState } from 'react'
import type { PendingQuestion } from '../lib/trace.js'

export interface QuestionPromptProps {
  question: PendingQuestion
  /** Send the operator's answer (a user_message) back to the waiting agent. */
  onAnswer: (text: string) => Promise<void>
}

/**
 * Surfaces the agent's pending `ask_user` question (R11, AE4) prominently and
 * gives the operator a focused answer input. Submitting sends the answer as a
 * `user_message` — the same carrier a follow-up uses — which the agent's parked
 * loop picks up to resume. Distinct from the generic composer so the operator
 * clearly sees the run is waiting on THEM, not idle.
 */
export function QuestionPrompt({ question, onAnswer }: QuestionPromptProps): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const submit = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      await onAnswer(trimmed)
      setText('')
    } catch {
      // Keep the typed answer so the operator can retry; the send surfaced its own
      // error. Clearing only on success prevents losing the answer on a failure.
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="question-prompt" data-testid="question-prompt">
      <div className="eyebrow">The agent is waiting on your answer</div>
      <div className="qp-question">{question.question}</div>
      <div className="qp-answer">
        <textarea
          className="composer-input"
          placeholder="Type your answer…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={sending}
        />
        <button className="btn primary sm" disabled={sending || !text.trim()} onClick={() => void submit()}>
          {sending ? 'Sending…' : 'Answer'}
        </button>
      </div>
    </div>
  )
}
