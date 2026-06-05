export interface DiffLine {
  t: 'ctx' | 'add' | 'del'
  code: string
  /** Line number on the relevant side: old-file line for ctx/del, new-file line for add. */
  n: number
  /**
   * True for the first line of a hunk that does not start at the top of the
   * file or immediately after the previous hunk — i.e. there is a collapsed gap
   * of unchanged lines before it. Lets the view draw a hunk separator.
   */
  hunkStart?: boolean
}

export interface FileDiff {
  add: number
  del: number
  lines: DiffLine[]
}

/** One step of the LCS backtrace: keep a shared line, drop an old line, or add a new line. */
type Op = 'eq' | 'del' | 'add'

/**
 * Longest-common-subsequence table over two line arrays. Classic dynamic
 * program: lcs[i][j] is the LCS length of a[i:] and b[j:]. Built bottom-up so
 * the backtrace from (0,0) walks forward through the files in order.
 */
function lcsLengths(a: readonly string[], b: readonly string[]): number[][] {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  return lcs
}

/**
 * Walk the LCS table from (0,0) producing the edit script in file order:
 * matched lines are `eq`, lines only in `a` are `del`, lines only in `b` are
 * `add`. Deletions are emitted before additions at a divergence so a changed
 * line reads removed-then-added.
 */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  const lcs = lcsLengths(a, b)
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push('eq')
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push('del')
      i++
    } else {
      ops.push('add')
      j++
    }
  }
  while (i < a.length) {
    ops.push('del')
    i++
  }
  while (j < b.length) {
    ops.push('add')
    j++
  }
  return ops
}

/** Lines of unchanged context kept on either side of a change before collapsing. */
const CONTEXT = 3

/**
 * Compute a line-level diff of `before` → `after` as added / removed / context
 * lines, grouped into hunks. Uses an LCS edit script so changes scattered through
 * a file produce multiple independent hunks (not one giant changed block), with
 * up to `CONTEXT` unchanged lines kept around each change and larger runs of
 * unchanged lines collapsed (the first line after a collapse is marked
 * `hunkStart`). Pure and immutable.
 */
export function computeDiff(before: string, after: string): FileDiff {
  const a = before.length > 0 ? before.split('\n') : []
  const b = after.length > 0 ? after.split('\n') : []
  const ops = editScript(a, b)

  // First pass: build every line (with its side line number) plus a changed flag.
  interface Raw {
    t: DiffLine['t']
    code: string
    n: number
    changed: boolean
  }
  const raw: Raw[] = []
  let oldN = 0
  let newN = 0
  let add = 0
  let del = 0
  for (const op of ops) {
    if (op === 'eq') {
      oldN++
      newN++
      raw.push({ t: 'ctx', code: a[oldN - 1]!, n: oldN, changed: false })
    } else if (op === 'del') {
      oldN++
      del++
      raw.push({ t: 'del', code: a[oldN - 1]!, n: oldN, changed: true })
    } else {
      newN++
      add++
      raw.push({ t: 'add', code: b[newN - 1]!, n: newN, changed: true })
    }
  }

  // Second pass: keep changed lines and up to CONTEXT context lines on each side;
  // drop the rest, marking the first surviving line after a drop as a hunk start.
  const keep = new Array<boolean>(raw.length).fill(false)
  for (let k = 0; k < raw.length; k++) {
    if (!raw[k]!.changed) continue
    for (let c = Math.max(0, k - CONTEXT); c <= Math.min(raw.length - 1, k + CONTEXT); c++) keep[c] = true
  }

  const lines: DiffLine[] = []
  let droppedBefore = false
  for (let k = 0; k < raw.length; k++) {
    if (!keep[k]) {
      droppedBefore = true
      continue
    }
    const r = raw[k]!
    lines.push({ t: r.t, code: r.code, n: r.n, ...(droppedBefore && k > 0 ? { hunkStart: true } : {}) })
    droppedBefore = false
  }

  return { add, del, lines }
}
