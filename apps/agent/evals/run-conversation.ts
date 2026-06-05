/**
 * run-conversation.ts — runner for the MULTI-TURN (conversation) goldens.
 *
 * Mirrors run.ts's local-scores path but drives runConversationGolden, which
 * injects each follow-up as a user_message and resumes the loop. Scores the
 * FINAL answer (after all turns) with the same deterministic evaluators, so a
 * pass means the agent kept the original goal across the conversation.
 *
 *   EVAL_DATABASE_URL=postgresql://steer:steer@localhost:54321/steer_eval?sslmode=disable \
 *     pnpm --filter @steer/agent eval:history
 */

import { conversationGoldens, type ConversationGolden } from './conversation.js'
import { runConversationGolden, closeHarness } from './harness.js'
import { evaluators } from './evaluators.js'

async function main(): Promise<void> {
  console.log('\nsteer-agent conversation round — multi-turn history (local scores)\n')
  const totals = new Map<string, number[]>()

  for (const golden of conversationGoldens) {
    const output = await runConversationGolden(golden)
    const cells: string[] = []
    for (const evaluate of evaluators) {
      const evaluation = await evaluate({
        input: golden.input,
        output,
        expectedOutput: golden.expectedOutput,
        metadata: golden.metadata,
      } as never)
      for (const e of Array.isArray(evaluation) ? evaluation : [evaluation]) {
        const v = Number(e.value)
        if (!totals.has(e.name)) totals.set(e.name, [])
        totals.get(e.name)!.push(v)
        cells.push(`${e.name}=${v.toFixed(2)}`)
      }
    }
    const turns = [golden.input, ...golden.followUps].map((t) => `"${t}"`).join(' → ')
    console.log(`• ${turns}`)
    console.log(`    ${cells.join('  ')}   [${output.status}] tools=[${output.toolsCalled.join(', ') || '—'}]`)
    console.log(`    → ${output.answer.replace(/\s+/g, ' ').slice(0, 200) || '(no answer)'}`)
  }

  console.log('\nAverages:')
  for (const [name, vals] of totals) {
    console.log(`    ${name}: ${((vals.reduce((a, b) => a + b, 0) / vals.length) * 100).toFixed(0)}%`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeHarness())

// Keep the type exported usage explicit for the typechecker.
export type { ConversationGolden }
