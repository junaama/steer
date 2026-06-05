import type { ExperimentItem } from '@langfuse/client'

export interface GoldenMetadata extends Record<string, unknown> {
  /** Fixture workspace directory under evals/fixtures the session runs in. */
  fixture: string
  /** Tools a competent agent should reach for (overlap is scored, not exact match). */
  expectedTools: string[]
  /** Substrings the final answer should contain (case-insensitive). */
  expectAnswerIncludes: string[]
  /** Model tier override (default: haiku — cheap + fast for evals). */
  model?: string
  /** Step ceiling override. */
  maxSteps?: number
}

export type Golden = ExperimentItem<string, string, GoldenMetadata>

/**
 * Hand-written read-only goldens (round 1). Every task is answerable with
 * read-only tools so the agent never trips the approval gate (which would block
 * an unattended eval — `resolveTool` polls for an approval that never comes).
 * Each golden names the tools a competent agent should use and substrings the
 * answer should contain — both scored off the REAL event log, never inferred.
 */
export const goldens: Golden[] = [
  {
    input: 'List the files and directories at the top level of this project.',
    expectedOutput: 'README.md, package.json, src/',
    metadata: { fixture: 'mini-repo', expectedTools: ['list_dir'], expectAnswerIncludes: ['readme', 'src'] },
  },
  {
    input: 'Read the README and tell me in one sentence what this project is.',
    expectedOutput: 'A tiny fixture project for the Steer agent eval goldens.',
    metadata: { fixture: 'mini-repo', expectedTools: ['read_file'], expectAnswerIncludes: ['fixture'] },
  },
  {
    input: 'Which file defines the function `slugify`?',
    expectedOutput: 'src/util.ts',
    metadata: { fixture: 'mini-repo', expectedTools: ['grep'], expectAnswerIncludes: ['util.ts'] },
  },
  {
    input: 'List every TypeScript (.ts) file in this project.',
    expectedOutput: 'src/math.ts and src/util.ts',
    metadata: { fixture: 'mini-repo', expectedTools: ['glob'], expectAnswerIncludes: ['math.ts', 'util.ts'] },
  },
  {
    input: 'What functions does src/math.ts export?',
    expectedOutput: 'add and multiply',
    metadata: { fixture: 'mini-repo', expectedTools: ['read_file'], expectAnswerIncludes: ['add', 'multiply'] },
  },
]
