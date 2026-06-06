import { describe, it, expect } from 'vitest'
import { toolCorrectness, taskCompletion, answerRelevancy, groundedness } from './evaluators.js'
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

describe('groundedness', () => {
  const comment = (e: unknown): string => (e as { comment: string }).comment

  it('is 1 for a grounded answer with no speculation', async () => {
    expect(value(await groundedness(params({ answer: 'math.ts exports add and multiply; util.ts defines slugify.' }, {})))).toBe(1)
  })

  it('is 0 when the answer speculates about file contents', async () => {
    // the exact failure: list the dir, then guess each file
    expect(value(await groundedness(params({ answer: 'ARCHITECTURE.md likely contains the architecture; backend/ probably holds the backend code.' }, {})))).toBe(0)
  })

  it('flags "appears to contain" / "might contain" hedging', async () => {
    expect(value(await groundedness(params({ answer: 'render.yaml appears to contain deploy config and might contain secrets.' }, {})))).toBe(0)
  })

  it('flags a bare "possibly a/the" guess', async () => {
    expect(value(await groundedness(params({ answer: 'CLAUDE.md is possibly a config for a tool named Claude.' }, {})))).toBe(0)
  })

  it('names the offending phrase in the comment', async () => {
    expect(comment(await groundedness(params({ answer: 'docs/ likely contains documentation.' }, {})))).toMatch(/likely contains/i)
  })
})
