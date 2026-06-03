export interface DiffLine {
  t: 'ctx' | 'add' | 'del'
  code: string
  n: number
}

export interface FileDiff {
  add: number
  del: number
  lines: DiffLine[]
}

/**
 * A small line-level diff: shared prefix/suffix as context, the changed middle
 * as removed-then-added. Good enough to render a write_file proposal clearly.
 */
export function computeDiff(before: string, after: string): FileDiff {
  const a = before.length > 0 ? before.split('\n') : []
  const b = after.length > 0 ? after.split('\n') : []

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++

  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const lines: DiffLine[] = []
  for (let i = 0; i < start; i++) lines.push({ t: 'ctx', code: a[i]!, n: i + 1 })
  for (let i = start; i < endA; i++) lines.push({ t: 'del', code: a[i]!, n: i + 1 })
  for (let i = start; i < endB; i++) lines.push({ t: 'add', code: b[i]!, n: i + 1 })
  for (let i = endA; i < a.length; i++) lines.push({ t: 'ctx', code: a[i]!, n: i + 1 })

  return { add: endB - start, del: endA - start, lines }
}
