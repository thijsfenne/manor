import { describe, expect, it } from 'vitest'
import type { DmFile } from '@manor/contracts'
import { dmFileReadsAs, filterDmFiles, groupDmFiles } from './dmFiles'

const DAY = 24 * 60 * 60 * 1000
const file = (name: string, kind: DmFile['kind'], mime: string, daysOld = 0, more: Partial<DmFile> = {}): DmFile =>
  ({ id: name, name, kind, mime, size: 10, ts: 100 * DAY - daysOld * DAY, ...more })

const files = [
  file('shot.png', 'image', 'image/png', 1),
  file('clip.mp4', 'video', 'video/mp4', 6.9),
  file('plan.pdf', 'pdf', 'application/pdf', 7),
  file('notes.md', 'file', 'text/markdown', 30),
]

describe('a DM file library', () => {
  it('filters media apart from files', () => {
    expect(filterDmFiles(files, 'all')).toHaveLength(4)
    expect(filterDmFiles(files, 'media').map((entry) => entry.name)).toEqual(['shot.png', 'clip.mp4'])
    expect(filterDmFiles(files, 'files').map((entry) => entry.name)).toEqual(['plan.pdf', 'notes.md'])
  })

  it('groups the last seven days apart and leaves an empty group out', () => {
    expect(groupDmFiles(files, 100 * DAY).map((group) => [group.label, group.files.map((entry) => entry.name)])).toEqual([
      ['This week', ['shot.png', 'clip.mp4']],
      ['Older', ['plan.pdf', 'notes.md']],
    ])
    expect(groupDmFiles(files.slice(2), 100 * DAY).map((group) => group.label)).toEqual(['Older'])
    expect(groupDmFiles([], 100 * DAY)).toEqual([])
  })

  it('reads text and markdown, and leaves a delivered page and a large file alone', () => {
    expect(dmFileReadsAs(files[3]!)).toBe('markdown')
    expect(dmFileReadsAs(file('data.json', 'file', 'application/json'))).toBe('text')
    expect(dmFileReadsAs(file('page.html', 'file', 'text/html', 0, { page: true }))).toBeNull()
    expect(dmFileReadsAs(file('big.csv', 'file', 'text/csv', 0, { size: 2 * 1_024 * 1_024 }))).toBeNull()
    expect(dmFileReadsAs(files[2]!)).toBeNull()
  })
})
