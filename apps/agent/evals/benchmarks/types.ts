import type { ExperimentItem } from '@langfuse/client'

/**
 * Metadata carried by every benchmark golden. Extends ExperimentItem so the
 * benchmarks can plug into the same Langfuse experiment path as the hand-written
 * goldens — but the localization grader lives here, not in Langfuse.
 */
export interface BenchmarkMeta extends Record<string, unknown> {
  /** Which benchmark this golden originates from. */
  source: 'swebench-verified' | 'terminal-bench'
  /**
   * Stable identifier from the upstream benchmark (e.g. "psf__requests-1142"
   * for SWE-bench, or the task directory name for Terminal-bench).
   */
  instanceId: string
  /** Source repo slug — present for SWE-bench, absent for Terminal-bench. */
  repo?: string
  /**
   * The specific git commit the benchmark was captured at. The harness shallow-
   * clones this commit so the agent operates on the exact state the gold patch
   * was written against.
   */
  baseCommit?: string
  /**
   * Files the gold patch touches — extracted from `diff --git a/<path> b/...`.
   * The localization evaluator measures how well the agent's edits overlap these.
   */
  goldFiles?: string[]
  /**
   * The FAIL_TO_PASS test IDs from SWE-bench (JSON-string encoded in the dataset,
   * decoded to a real array here). Not executed by this harness — recorded so a
   * future tier with the SWE-bench Docker harness can run them.
   */
  failToPass?: string[]
  /** Model tier override — defaults to the provider's cheapest fast model. */
  model?: string
  /** Step ceiling override — keep generous for real bugs (default 30). */
  maxSteps?: number
}

/** One benchmark task item, shaped for both local scoring and Langfuse upload. */
export type BenchmarkGolden = ExperimentItem<string, string, BenchmarkMeta>
