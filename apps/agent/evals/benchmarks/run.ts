/**
 * run.ts — benchmark runner for SWE-bench + Terminal-bench goldens.
 *
 * Mirrors evals/run.ts (local-scores path) but uses the benchmark harness and
 * localization evaluator. No Langfuse keys needed — scores are printed locally.
 *
 * Usage (run one named instance):
 *   EVAL_DATABASE_URL=postgresql://steer:steer@localhost:54321/steer_eval?sslmode=disable \
 *   pnpm --filter @steer/agent run eval:bench -- psf__requests-1142
 *
 * Or all instances (slow — each clones a repo and runs the real agent):
 *   pnpm --filter @steer/agent run eval:bench
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { BenchmarkGolden, BenchmarkMeta } from './types.js'
import { runBenchmarkGolden, closeBenchmarkHarness } from './harness.js'
import { localizationF1 } from './localization.js'

const here = dirname(fileURLToPath(import.meta.url))

async function loadGoldens(): Promise<BenchmarkGolden[]> {
  const [sweRaw, tbRaw] = await Promise.all([
    readFile(join(here, 'swebench-verified.json'), 'utf8'),
    readFile(join(here, 'terminal-bench.json'), 'utf8'),
  ])
  return [
    ...(JSON.parse(sweRaw) as BenchmarkGolden[]),
    ...(JSON.parse(tbRaw) as BenchmarkGolden[]),
  ]
}

async function main(): Promise<void> {
  const all = await loadGoldens()

  // Optional CLI filter: `eval:bench -- <instanceId>` runs just that one golden
  const filter = process.argv[2]
  const goldens = filter ? all.filter((g) => (g.metadata as BenchmarkMeta).instanceId === filter) : all

  if (goldens.length === 0) {
    console.error(`No goldens found${filter ? ` matching "${filter}"` : ''}`)
    process.exitCode = 1
    return
  }

  console.log(`\nBenchmark eval — ${goldens.length} instance(s)\n`)

  const totals = new Map<string, number[]>()

  for (const golden of goldens) {
    const meta = golden.metadata as BenchmarkMeta
    console.log(`\n▶  ${meta.instanceId}  [${meta.source}]${meta.repo ? `  repo=${meta.repo}` : ''}`)
    if (meta.goldFiles?.length) {
      console.log(`   gold files: [${meta.goldFiles.join(', ')}]`)
    }

    let result
    try {
      result = await runBenchmarkGolden(golden)
    } catch (err: unknown) {
      console.error(`   ERROR running golden: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const { name, value, comment } = localizationF1(result.editedFiles, result.goldFiles)
    if (!totals.has(name)) totals.set(name, [])
    totals.get(name)!.push(value)

    console.log(`   edited files: [${result.editedFiles.join(', ') || '—'}]`)
    console.log(`   ${name}=${value.toFixed(3)}  ${comment}`)
    console.log(`   status=${result.status}  steps=${result.toolsCalled.length}`)
    if (result.answer) {
      console.log(`   answer: ${result.answer.replace(/\s+/g, ' ').slice(0, 200)}`)
    }
  }

  if (totals.size > 0) {
    console.log('\nAverages:')
    for (const [metricName, vals] of totals) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length
      console.log(`  ${metricName}: ${(avg * 100).toFixed(1)}%  (n=${vals.length})`)
    }
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeBenchmarkHarness())
