/**
 * pull.ts — fetch real SWE-bench Verified + Terminal-bench instances and write
 * them to JSON files in this directory. Run with:
 *   pnpm --filter @steer/agent exec tsx evals/benchmarks/pull.ts
 *
 * Uses global `fetch` (Node 18+). Does NOT write secrets, keys, or tokens.
 */

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { BenchmarkGolden, BenchmarkMeta } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// SWE-bench Verified
// ---------------------------------------------------------------------------

interface SwebenchRow {
  repo: string
  instance_id: string
  base_commit: string
  problem_statement: string
  patch: string
  FAIL_TO_PASS: string
}

/** Extract unique changed file paths from a unified diff's `diff --git a/<f> b/` headers. */
function goldFilesFromPatch(patch: string): string[] {
  const seen = new Set<string>()
  const re = /diff --git a\/(\S+) b\//g
  let m: RegExpExecArray | null
  while ((m = re.exec(patch)) !== null) {
    seen.add(m[1]!)
  }
  return [...seen]
}

async function fetchSwebenchRows(offset: number, length: number): Promise<SwebenchRow[]> {
  const url =
    `https://datasets-server.huggingface.co/rows` +
    `?dataset=princeton-nlp/SWE-bench_Verified&config=default&split=test` +
    `&offset=${offset}&length=${length}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`SWE-bench rows fetch failed: ${res.status} ${res.statusText}`)
  const data = (await res.json()) as { rows: { row: SwebenchRow }[] }
  return data.rows.map((r) => r.row)
}

async function pullSwebench(): Promise<BenchmarkGolden[]> {
  const goldens: BenchmarkGolden[] = []

  // Window ~240-320 holds psf/requests + pallets/flask. Fetch two windows to be
  // sure we get both repos, then filter + deduplicate by instance_id.
  const [window1, window2] = await Promise.all([
    fetchSwebenchRows(240, 80),
    fetchSwebenchRows(0, 10),
  ])
  const all = [...window1, ...window2]

  // Target: at least 2 psf/requests + 1 pallets/flask, plus a few astropy
  const targetRepos = new Set(['psf/requests', 'pallets/flask', 'astropy/astropy'])
  const seenIds = new Set<string>()

  // Repo quotas so we get variety
  const quota: Record<string, number> = { 'psf/requests': 4, 'pallets/flask': 2, 'astropy/astropy': 4 }

  for (const row of all) {
    if (!targetRepos.has(row.repo)) continue
    const cap = quota[row.repo] ?? 2
    const existing = goldens.filter((g) => (g.metadata as BenchmarkMeta).repo === row.repo).length
    if (existing >= cap) continue
    if (seenIds.has(row.instance_id)) continue
    seenIds.add(row.instance_id)

    const goldFiles = goldFilesFromPatch(row.patch)
    let failToPass: string[] = []
    try {
      failToPass = JSON.parse(row.FAIL_TO_PASS) as string[]
    } catch {
      failToPass = []
    }

    const meta: BenchmarkMeta = {
      source: 'swebench-verified',
      instanceId: row.instance_id,
      repo: row.repo,
      baseCommit: row.base_commit,
      goldFiles,
      failToPass,
      model: 'haiku',
      maxSteps: 30,
    }

    goldens.push({
      input: row.problem_statement,
      // Gold output is the repo+patch coordinates — used as a reference label.
      expectedOutput: goldFiles.join(', '),
      metadata: meta,
    })
  }

  return goldens
}

// ---------------------------------------------------------------------------
// Terminal-bench (harbor-framework/terminal-bench)
// ---------------------------------------------------------------------------

interface GithubContentItem {
  name: string
  type: string
}

interface GithubFileContent {
  content: string
}

async function fetchTerminalBenchTaskNames(): Promise<string[]> {
  const res = await fetch(
    'https://api.github.com/repos/harbor-framework/terminal-bench/contents/original-tasks',
  )
  if (!res.ok) throw new Error(`Terminal-bench listing failed: ${res.status} ${res.statusText}`)
  const items = (await res.json()) as GithubContentItem[]
  return items.filter((i) => i.type === 'dir').map((i) => i.name)
}

async function fetchTerminalBenchInstruction(taskName: string): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/harbor-framework/terminal-bench/contents/original-tasks/${taskName}/task.yaml`,
  )
  if (!res.ok) return null
  const data = (await res.json()) as GithubFileContent
  const raw = Buffer.from(data.content, 'base64').toString('utf8')

  // Parse the `instruction:` field from YAML manually (avoids adding a yaml dep).
  // Supports both `instruction: |` and `instruction: |-` block scalar styles.
  const lines = raw.split('\n')
  let inInstruction = false
  const instructionLines: string[] = []
  for (const line of lines) {
    if (/^instruction:\s*(\|[-+]?)?$/.test(line)) {
      inInstruction = true
      continue
    }
    if (/^instruction:\s+\S/.test(line)) {
      // Inline value (not block scalar)
      return line.replace(/^instruction:\s+/, '').trim()
    }
    if (inInstruction) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        instructionLines.push(line.replace(/^  /, ''))
      } else if (line.trim() === '') {
        instructionLines.push('')
      } else {
        break
      }
    }
  }
  if (instructionLines.length === 0) return null
  return instructionLines.join('\n').trim()
}

// A curated set of ~10 Terminal-bench tasks. Chosen for variety across
// categories (systems, data-science, coding, file-ops). These are real task
// directory names confirmed present in harbor-framework/terminal-bench.
const TERMINAL_BENCH_TARGETS = [
  'analyze-access-logs',
  'assign-seats',
  'cancel-async-tasks',
  'bank-trans-filter',
  'broken-python',
  'audio-synth-stft-peaks',
  'accelerate-maximal-square',
  'acl-permissions-inheritance',
  'blind-maze-explorer-5x5',
  'cartpole-rl-training',
]

async function pullTerminalBench(): Promise<BenchmarkGolden[]> {
  const results = await Promise.allSettled(
    TERMINAL_BENCH_TARGETS.map(async (name) => {
      const instruction = await fetchTerminalBenchInstruction(name)
      if (!instruction) throw new Error(`No instruction for ${name}`)
      const meta: BenchmarkMeta = {
        source: 'terminal-bench',
        instanceId: name,
        model: 'haiku',
        maxSteps: 30,
      }
      return {
        input: instruction,
        expectedOutput: '',
        metadata: meta,
      } satisfies BenchmarkGolden
    }),
  )

  const goldens: BenchmarkGolden[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') goldens.push(r.value)
    else console.error(`  terminal-bench fetch error: ${(r.reason as Error).message}`)
  }
  return goldens
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Pulling SWE-bench Verified goldens …')
  const swe = await pullSwebench()
  console.log(`  → ${swe.length} SWE-bench instances`)
  for (const g of swe) {
    const m = g.metadata as BenchmarkMeta
    console.log(`    ${m.instanceId}  repo=${m.repo}  goldFiles=[${m.goldFiles?.join(', ')}]`)
  }
  await writeFile(join(here, 'swebench-verified.json'), JSON.stringify(swe, null, 2), 'utf8')
  console.log('  Wrote swebench-verified.json')

  console.log('\nPulling Terminal-bench goldens …')
  const tb = await pullTerminalBench()
  console.log(`  → ${tb.length} Terminal-bench tasks`)
  for (const g of tb) {
    const m = g.metadata as BenchmarkMeta
    console.log(`    ${m.instanceId}`)
  }
  await writeFile(join(here, 'terminal-bench.json'), JSON.stringify(tb, null, 2), 'utf8')
  console.log('  Wrote terminal-bench.json')

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
