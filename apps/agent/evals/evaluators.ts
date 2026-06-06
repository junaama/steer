import type { Evaluator, EvaluatorParams } from '@langfuse/client'
import type { TaskResult } from './harness.js'
import type { GoldenMetadata } from './goldens.js'

type Params = EvaluatorParams<string, string, GoldenMetadata>

function taskResult(params: Params): TaskResult {
  return params.output as TaskResult
}

/**
 * Tool correctness: the fraction of the golden's expected tools the agent
 * actually proposed. Scored off the real `tool_proposed` events, so it measures
 * what the agent *did*, not what it claimed.
 */
export const toolCorrectness: Evaluator = async (params) => {
  const p = params as Params
  const { toolsCalled } = taskResult(p)
  const expected = p.metadata?.expectedTools ?? []
  if (expected.length === 0) return { name: 'tool_correctness', value: 1, comment: 'no expected tools' }
  const used = new Set(toolsCalled)
  const hits = expected.filter((tool) => used.has(tool))
  return {
    name: 'tool_correctness',
    value: hits.length / expected.length,
    comment: `expected [${expected.join(', ')}], used [${toolsCalled.join(', ') || '—'}]`,
  }
}

/** Task completion: 1 only when the run finished cleanly with a non-empty answer. */
export const taskCompletion: Evaluator = async (params) => {
  const p = params as Params
  const { status, answer } = taskResult(p)
  return {
    name: 'task_completion',
    value: status === 'completed' && answer.length > 0 ? 1 : 0,
    comment: `status=${status}, answer_len=${answer.length}`,
  }
}

/**
 * Answer relevancy: the fraction of expected substrings present in the final
 * answer (case-insensitive). Deterministic and offline — no judge model — so
 * round 1 needs only an LLM key for the agent itself.
 */
export const answerRelevancy: Evaluator = async (params) => {
  const p = params as Params
  const { answer } = taskResult(p)
  const needles = p.metadata?.expectAnswerIncludes ?? []
  if (needles.length === 0) return { name: 'answer_relevancy', value: 1, comment: 'no expected substrings' }
  const hay = answer.toLowerCase()
  const hits = needles.filter((needle) => hay.includes(needle.toLowerCase()))
  return {
    name: 'answer_relevancy',
    value: hits.length / needles.length,
    comment: `matched ${hits.length}/${needles.length}: [${needles.join(', ')}]`,
  }
}

/**
 * Speculation about file contents — the "ARCHITECTURE.md likely contains the
 * architecture" failure. A grounded agent opens the file and states what it
 * actually holds, so hedging-about-contents phrases mean it guessed from names
 * instead of reading. Deterministic + offline (no judge model): 1 when clean,
 * 0 when the answer speculates, with the offending phrase in the comment.
 */
const SPECULATION_PATTERNS: RegExp[] = [
  /\b(likely|probably|possibly|presumably|might|may)\s+(contains?|holds?|includes?|stores?|relate[sd]?|be\b)/i,
  /\b(likely|probably|possibly|presumably)\s+(a|an|the)\b/i,
  /\bappears?\s+to\s+(contain|be|hold|include)/i,
]

export const groundedness: Evaluator = async (params) => {
  const { answer } = taskResult(params as Params)
  const hits = SPECULATION_PATTERNS.map((re) => answer.match(re)?.[0]).filter(
    (m): m is string => typeof m === 'string',
  )
  return {
    name: 'groundedness',
    value: hits.length === 0 ? 1 : 0,
    comment:
      hits.length === 0
        ? 'no speculation about file contents'
        : `speculated instead of reading: "${hits.join('", "')}"`,
  }
}

export const evaluators: Evaluator[] = [toolCorrectness, taskCompletion, answerRelevancy, groundedness]
