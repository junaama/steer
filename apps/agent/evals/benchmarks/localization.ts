/**
 * localization.ts — outcome-based file-localization grader.
 *
 * Following Anthropic's eval guidance ("prefer outcome-based over tool-sequence
 * graders"), this evaluator measures the agent's real filesystem edits against
 * the gold-patch changed files. It does NOT inspect which tools were called —
 * only what files were actually modified on disk.
 *
 * Metrics:
 *   precision = |edited ∩ gold| / |edited|   — what fraction of edits were correct
 *   recall    = |edited ∩ gold| / |gold|      — what fraction of gold files were edited
 *   F1        = harmonic mean of precision + recall
 *
 * A perfect score = 1.0; a completely disjoint edit set = 0.0.
 * Empty edited-file set always yields F1 = 0.0 (agent made no edits).
 */

export interface LocalizationResult {
  name: 'localization_f1'
  value: number
  comment: string
}

/**
 * Compute precision / recall / F1 for file localization.
 *
 * @param editedFiles - files the agent actually modified (from `git diff --name-only`)
 * @param goldFiles   - files the gold patch touched (extracted from the patch diff headers)
 */
export function localizationF1(editedFiles: readonly string[], goldFiles: readonly string[]): LocalizationResult {
  const edited = new Set(editedFiles)
  const gold = new Set(goldFiles)

  // Empty edits → always 0 (agent did nothing)
  if (edited.size === 0) {
    return {
      name: 'localization_f1',
      value: 0,
      comment: `no edits — gold=[${[...gold].join(', ')}]`,
    }
  }

  // No gold files recorded (e.g. Terminal-bench) → undefined; score 0 with a note
  if (gold.size === 0) {
    return {
      name: 'localization_f1',
      value: 0,
      comment: `no gold files to compare against (terminal-bench task); edited=[${[...edited].join(', ')}]`,
    }
  }

  const hits = [...edited].filter((f) => gold.has(f)).length
  const precision = hits / edited.size
  const recall = hits / gold.size
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return {
    name: 'localization_f1',
    value: f1,
    comment:
      `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} f1=${f1.toFixed(3)}` +
      ` | edited=[${[...edited].join(', ')}]` +
      ` | gold=[${[...gold].join(', ')}]`,
  }
}
