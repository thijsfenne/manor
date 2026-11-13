import { describe, expect, it } from 'vitest'
import type { SessionDiffFile } from '@manor/contracts'
import { changeRuns, sessionDiffView, splitRows, withoutWhitespaceChanges, type DiffViewFile } from '../src/diffView'

const file = (patch: Partial<SessionDiffFile>): SessionDiffFile => ({
  root: '/repo', path: 'src/a.ts', status: 'edited', added: 1, removed: 1, hunks: [], ...patch,
})

describe('the diff pane’s files', () => {
  it('numbers each side from the hunk header and marks the lines left out between hunks', () => {
    const [view] = sessionDiffView([file({
      hunks: [
        { oldStart: 3, newStart: 3, lines: [' keep', '-old', '+new'] },
        { oldStart: 20, newStart: 20, lines: [' tail'] },
      ],
    })])
    expect(view!.rows).toEqual([
      { kind: 'gap', count: 2 },
      { kind: 'same', text: 'keep', oldNo: 3, newNo: 3 },
      { kind: 'removed', text: 'old', oldNo: 4 },
      { kind: 'added', text: 'new', newNo: 4 },
      { kind: 'gap', count: 15 },
      { kind: 'same', text: 'tail', oldNo: 20, newNo: 20 },
    ])
  })

  it('names files by folder only when the Session has more than one', () => {
    const one = sessionDiffView([file({ panelPath: 'repo/src/a.ts' })])
    const two = sessionDiffView([file({ panelPath: 'repo/src/a.ts' }), file({ root: '/other', path: 'b.ts', panelPath: 'other/b.ts' })])
    expect(one.map((view) => view.path)).toEqual(['src/a.ts'])
    expect(two.map((view) => view.path)).toEqual(['repo/src/a.ts', 'other/b.ts'])
  })

  it('hides a change that only moved whitespace, and a file left with nothing else', () => {
    const view = (rows: DiffViewFile['rows'], added: number, removed: number): DiffViewFile => ({
      key: String(rows.length), path: 'a.ts', status: 'edited', added, removed, binary: false, truncated: false, rows,
    })
    const spaced = view([{ kind: 'removed', text: 'a(b)', oldNo: 1 }, { kind: 'added', text: 'a( b )', newNo: 1 }], 1, 1)
    const real = view([{ kind: 'removed', text: 'a', oldNo: 1 }, { kind: 'added', text: 'b', newNo: 1 }, { kind: 'added', text: 'c', newNo: 2 }], 2, 1)
    const { files, hidden } = withoutWhitespaceChanges([spaced, real])
    expect(hidden).toBe(1)
    expect(files).toEqual([real])
  })

  it('pairs removed and added runs side by side and keeps unchanged lines on both sides', () => {
    expect(splitRows([
      { kind: 'same', text: 'x', oldNo: 1, newNo: 1 },
      { kind: 'removed', text: 'a', oldNo: 2 },
      { kind: 'removed', text: 'b', oldNo: 3 },
      { kind: 'added', text: 'c', newNo: 2 },
    ])).toEqual([
      { kind: 'pair', left: { kind: 'same', text: 'x', oldNo: 1, newNo: 1 }, right: { kind: 'same', text: 'x', oldNo: 1, newNo: 1 } },
      { kind: 'pair', left: { kind: 'removed', text: 'a', oldNo: 2 }, right: { kind: 'added', text: 'c', newNo: 2 } },
      { kind: 'pair', left: { kind: 'removed', text: 'b', oldNo: 3 } },
    ])
  })
})

describe('change markers', () => {
  it('marks each run of changed lines once, by what it does', () => {
    expect(changeRuns([
      { kind: 'same', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'removed', text: 'b', oldNo: 2 },
      { kind: 'added', text: 'B', newNo: 2 },
      { kind: 'same', text: 'c', oldNo: 3, newNo: 3 },
      { kind: 'gap', count: 9 },
      { kind: 'added', text: 'd', newNo: 13 },
      { kind: 'added', text: 'e', newNo: 14 },
    ])).toEqual([{ start: 1, length: 2, tone: 'both' }, { start: 5, length: 2, tone: 'added' }])
  })
})
