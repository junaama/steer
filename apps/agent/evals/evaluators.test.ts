import { describe, it, expect } from 'vitest'
import { toolCorrectness, taskCompletion, answerRelevancy } from './evaluators.js'
import type { TaskResult } from './harness.js'

/** Build an EvaluatorParams-shaped object; evaluators only read `output` + `metadata`. */
function params(output: Partial<TaskResult>, metadata: Record<string, unknown>): never {
  return {
    input: 'task',
    expectedOutput: '',
    metadata,
    output: { answer: '', toolsCalled: [], status: 'completed', sessionId: 's', ...output },
  } as never
}

const value = (e: unknown): number => (e as { value: number }).value

describe('toolCorrectness', () => {
  it('scores 1 when the expected tool was used', async () => {
    expect(value(await toolCorrectness(params({ toolsCalled: ['list_dir'] }, { expectedTools: ['list_dir'] })))).toBe(1)
  })

  it('scores 0 when the expected tool was not used', async () => {
    expect(value(await toolCorrectness(params({ toolsCalled: ['read_file'] }, { expectedTools: ['grep'] })))).toBe(0)
  })

  it('scores the overlap fraction across multiple expected tools', async () => {
    expect(
      value(await toolCorrectness(params({ toolsCalled: ['grep'] }, { expectedTools: ['grep', 'read_file'] }))),
    ).toBe(0.5)
  })

  it('is 1 when no tools are expected', async () => {
    expect(value(await toolCorrectness(params({ toolsCalled: [] }, { expectedTools: [] })))).toBe(1)
  })
})

describe('taskCompletion', () => {
  it('is 1 only when completed with a non-empty answer', async () => {
    expect(value(await taskCompletion(params({ status: 'completed', answer: 'done' }, {})))).toBe(1)
  })

  it('is 0 when the run errored', async () => {
    expect(value(await taskCompletion(params({ status: 'error', answer: 'partial' }, {})))).toBe(0)
  })

  it('is 0 when completed but the answer is empty', async () => {
    expect(value(await taskCompletion(params({ status: 'completed', answer: '' }, {})))).toBe(0)
  })
})

describe('answerRelevancy', () => {
  it('is 1 when all expected substrings are present (case-insensitive)', async () => {
    const e = await answerRelevancy(params({ answer: 'It exports ADD and MULTIPLY' }, { expectAnswerIncludes: ['add', 'multiply'] }))
    expect(value(e)).toBe(1)
  })

  it('is the fraction of substrings matched', async () => {
    const e = await answerRelevancy(params({ answer: 'only add here' }, { expectAnswerIncludes: ['add', 'multiply'] }))
    expect(value(e)).toBe(0.5)
  })

  it('is 1 when nothing is expected', async () => {
    expect(value(await answerRelevancy(params({ answer: '' }, { expectAnswerIncludes: [] })))).toBe(1)
  })
})
