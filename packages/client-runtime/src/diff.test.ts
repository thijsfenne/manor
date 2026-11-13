import { describe, expect, it } from 'vitest'
import { collapseContext, diffLines, numberedDiff } from './diff'

describe('numberedDiff', () => {
  const rows = collapseContext(diffLines('keep\nold\nkeep\n', 'keep\nnew\nkeep\n'))

  it('numbers from where the hunk sits in the file', () => {
    expect(numberedDiff(rows, { before: 41, after: 44 }).map((row) => row.number)).toEqual([45, 43, 46, 47])
  })

  it('leaves the gutter empty when the position is unknown', () => {
    expect(numberedDiff(rows, undefined).every((row) => !('number' in row))).toBe(true)
  })
})
