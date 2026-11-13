/**
 * A line diff for showing what an agent changed. Drivers hand over the two sides of
 * a hunk already capped, so this only ever runs over a few hundred lines and a
 * plain LCS table is the right amount of machinery.
 */

export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

export interface DiffStat {
  added: number
  removed: number
}

/** Lines the way a diff counts them: a trailing newline is a terminator, not a line. */
function toLines(value: string): string[] {
  if (value.length === 0) return []
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Longest common subsequence over lines, walked back into an ordered diff. Quadratic
 * in the number of lines, which is fine against the caps and keeps the result exact:
 * a heuristic differ would occasionally show a change that did not happen.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = toLines(before)
  const right = toLines(after)

  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ kind: 'same', text: left[i]! })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: left[i]! })
      i += 1
    } else {
      lines.push({ kind: 'added', text: right[j]! })
      j += 1
    }
  }
  while (i < left.length) {
    lines.push({ kind: 'removed', text: left[i]! })
    i += 1
  }
  while (j < right.length) {
    lines.push({ kind: 'added', text: right[j]! })
    j += 1
  }
  return lines
}

export function diffStat(lines: DiffLine[]): DiffStat {
  return {
    added: lines.filter((line) => line.kind === 'added').length,
    removed: lines.filter((line) => line.kind === 'removed').length,
  }
}

/**
 * The diff for one edit, walked once per edit and then remembered.
 *
 * Two things ask for it now: the summary a finished turn ends with, which counts
 * every file whether or not anyone opens it, and the diff row itself. The walk is
 * quadratic, so counting a turn's files must not make the transcript pay for it
 * again the moment one of them is unfolded. Keyed on the edit object, which the
 * thread state hands out by reference and never rewrites.
 */
const linesByEdit = new WeakMap<object, DiffLine[]>()

export function editLines(edit: { before?: string; after?: string }): DiffLine[] {
  const cached = linesByEdit.get(edit)
  if (cached !== undefined) return cached
  const lines = diffLines(edit.before ?? '', edit.after ?? '')
  linesByEdit.set(edit, lines)
  return lines
}

/**
 * The ± counts for one edit, remembered for the same reason and one step further:
 * the summary re-counts every file in the thread on every delta that arrives, and
 * walking a cached line list is still a walk.
 */
const statByEdit = new WeakMap<object, DiffStat>()

export function editStat(edit: { before?: string; after?: string }): DiffStat {
  const cached = statByEdit.get(edit)
  if (cached !== undefined) return cached
  const stat = diffStat(editLines(edit))
  statByEdit.set(edit, stat)
  return stat
}

/**
 * Drops runs of unchanged lines that are far from any change, the way a unified diff
 * does. Long context is what makes a diff unreadable in a chat transcript, and the
 * elided count is rendered so nothing looks like it silently disappeared.
 */
export function collapseContext(lines: DiffLine[], radius = 2): (DiffLine | { kind: 'gap'; count: number })[] {
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (let at = index - radius; at <= index + radius; at += 1) {
      if (at >= 0 && at < lines.length) keep.add(at)
    }
  })

  const out: (DiffLine | { kind: 'gap'; count: number })[] = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipped > 0) {
        out.push({ kind: 'gap', count: skipped })
        skipped = 0
      }
      out.push(line)
    } else {
      skipped += 1
    }
  })
  if (skipped > 0) out.push({ kind: 'gap', count: skipped })
  return out
}

export type DiffRow = ReturnType<typeof collapseContext>[number]

/**
 * The number the line has in the file you would open. Removed lines are numbered in
 * the old file and everything else in the new one, so the gutter always answers "where
 * do I look" rather than counting rows on screen. Gaps advance both sides at once —
 * they are unchanged by definition. Without the hunk's `offset` nothing is numbered:
 * counting a fragment from 1 printed numbers that matched no line in the file.
 */
export function numberedDiff(
  rows: DiffRow[],
  offset: { before: number; after: number } | undefined,
): (DiffRow & { number?: number })[] {
  if (offset === undefined) return rows
  let before = offset.before
  let after = offset.after
  return rows.map((row) => {
    if (row.kind === 'gap') {
      before += row.count
      after += row.count
      return row
    }
    if (row.kind === 'removed') {
      before += 1
      return { ...row, number: before }
    }
    if (row.kind === 'added') {
      after += 1
      return { ...row, number: after }
    }
    before += 1
    after += 1
    return { ...row, number: after }
  })
}
