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

export const evaluators: Evaluator[] = [toolCorrectness, taskCompletion, answerRelevancy]
