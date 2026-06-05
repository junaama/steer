import { LangfuseClient, type ExperimentTask } from '@langfuse/client'
import { startTracing, flushTracing, shutdownTracing, tracingEnabled } from '../src/tracing.js'
import { goldens, type Golden } from './goldens.js'
import { runGolden, closeHarness } from './harness.js'
import { evaluators } from './evaluators.js'

const EXPERIMENT_NAME = 'steer-agent read-only round'
const DESCRIPTION = 'Read-only coding-agent goldens scored on tool choice, completion, and answer match.'
const DATASET_NAME = 'steer-agent-goldens'

/**
 * Upsert the goldens as a named Langfuse dataset so experiment runs land in the
 * Datasets → Experiments comparison view (run-over-run), not just Tracing.
 * Datasets upsert on name and items upsert on `id`, so re-seeding is idempotent —
 * no duplicate items across runs.
 */
async function seedDataset(langfuse: LangfuseClient): Promise<void> {
  await langfuse.api.datasets.create({ name: DATASET_NAME, description: DESCRIPTION })
  for (const [i, golden] of goldens.entries()) {
    await langfuse.api.datasetItems.create({
      datasetName: DATASET_NAME,
      id: `steer-golden-${i + 1}`,
      input: golden.input,
      expectedOutput: golden.expectedOutput,
      metadata: golden.metadata,
    })
  }
}

/**
 * With Langfuse keys set: seed the named dataset, then run the experiment against
 * it so each run is a comparable dataset run (Experiments view) with traces +
 * scores. The task and evaluators are identical to the local path — same scores.
 */
async function viaLangfuse(): Promise<void> {
  startTracing()
  const langfuse = new LangfuseClient()
  await seedDataset(langfuse)
  const dataset = await langfuse.dataset.get(DATASET_NAME)
  const task: ExperimentTask = async (item) => runGolden(item as Golden)
  const result = await dataset.runExperiment({
    name: EXPERIMENT_NAME,
    description: DESCRIPTION,
    task,
    evaluators,
    maxConcurrency: 2,
  })
  console.log(await result.format())
  await flushTracing()
  await shutdownTracing()
}

/**
 * Keyless fallback: run every golden + evaluator locally and print the scores,
 * so the build loop works with only an LLM key + Postgres (no Langfuse server).
 * Same goldens, harness, and evaluators — identical scores, just no upload.
 */
async function viaLocalScores(): Promise<void> {
  console.log(`\n${EXPERIMENT_NAME} — local scores (no LANGFUSE_* keys set)\n`)
  const totals = new Map<string, number[]>()
  for (const golden of goldens) {
    const output = await runGolden(golden)
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
    console.log(`• ${String(golden.input).slice(0, 62)}`)
    console.log(`    ${cells.join('  ')}   [${output.status}] tools=[${output.toolsCalled.join(', ') || '—'}]`)
    console.log(`    → ${output.answer.replace(/\s+/g, ' ').slice(0, 200) || '(no answer)'}`)
  }
  console.log('\nAverages:')
  for (const [name, vals] of totals) {
    console.log(`    ${name}: ${((vals.reduce((a, b) => a + b, 0) / vals.length) * 100).toFixed(0)}%`)
  }
}

async function main(): Promise<void> {
  try {
    if (tracingEnabled()) await viaLangfuse()
    else await viaLocalScores()
  } finally {
    await closeHarness()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
