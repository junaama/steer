import type { GoldenMetadata } from './goldens.js'

/**
 * A multi-turn golden: an original task followed by clarifying user messages.
 * The point of the eval is conversational continuity — after a follow-up, the
 * agent must still pursue and COMPLETE the original request, not answer the last
 * message in isolation.
 */
export interface ConversationGolden {
  /** The original task (turn 1). */
  input: string
  /** Follow-up user messages, each injected after the prior turn settles. */
  followUps: string[]
  /** Reference answer (human-readable; scoring uses metadata.expectAnswerIncludes). */
  expectedOutput: string
  metadata: GoldenMetadata
}

/**
 * Hand-written conversation goldens. These reproduce the real failure observed in
 * session sess-eeb54402: the user asked for the first line of a README in a
 * folder, the agent couldn't find it at the named path and gave up, and after the
 * user supplied the real path the agent described the folder instead of finishing
 * the original task. A passing run requires the FINAL answer (after all turns) to
 * contain the original answer — proving the agent kept the goal across the turn.
 */
export const conversationGoldens: ConversationGolden[] = [
  {
    input: 'List the files in this directory.',
    followUps: ['It should be in ~/dev/steer.'],
    expectedOutput: 'README.md and package.json',
    metadata: {
      model: 'sonnet',
      fixture: 'home/dev/steer',
      rootFixture: '.',
      homeFixture: 'home',
      sessionWorkdir: '~/dev/steer',
      expectedTools: ['list_dir'],
      expectAnswerIncludes: ['README.md', 'package.json'],
      maxSteps: 18,
    },
  },
  {
    // Pure conversational memory — the simplest "maintain history" check: the
    // follow-up can only be answered from the first turn's message.
    input: 'Remember this token for later: STEER-7788. Just acknowledge it.',
    followUps: ['What token did I ask you to remember?'],
    expectedOutput: 'STEER-7788',
    metadata: { fixture: 'nested-repo', expectedTools: [], expectAnswerIncludes: ['STEER-7788'], maxSteps: 12 },
  },
  {
    // The real scenario: the README is nested under packages/widget, not at the
    // path the user first names. After the clarification the agent must read that
    // README and return its first line ("# Widget Library"), not summarize the dir.
    input: 'What is the first line of the README in the widget folder?',
    followUps: ["it's in packages/widget"],
    expectedOutput: '# Widget Library',
    metadata: {
      // sonnet tier — the production default (intake.ts) and the model the real
      // sess-eeb54402 failure was observed on.
      model: 'sonnet',
      fixture: 'nested-repo',
      expectedTools: ['read_file'],
      expectAnswerIncludes: ['Widget Library'],
      maxSteps: 24,
    },
  },
]
