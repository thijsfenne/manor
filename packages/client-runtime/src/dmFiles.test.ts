import { describe, expect, it } from 'vitest'
import type { DeliveredFile, DmFile } from '@manor/contracts'
import { dmFileReadsAs, eventImageFiles, filterDmFiles, groupDmFiles, splitDeliveredFiles } from './dmFiles'

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

describe('delivered files in the transcript', () => {
  const delivered = (name: string, mime: string, gone = false): DeliveredFile =>
    ({ id: name, name, mime, size: 10, ...(gone ? {} : { src: `/media/c/${name}/f0/sig` }) })

  it('draws pictures instead of listing them, once, and keeps every other file a row', () => {
    const { rows, pictures } = splitDeliveredFiles([
      delivered('one.png', 'image/png'),
      delivered('two.webp', 'image/webp'),
      delivered('report.pdf', 'application/pdf'),
      delivered('logo.svg', 'image/svg+xml'),
      delivered('gone.png', 'image/png', true),
    ], [{ name: 'one.png', src: '/media/c/m/0/sig' }])
    expect(rows.map((file) => file.name)).toEqual(['report.pdf', 'logo.svg', 'gone.png'])
    expect(pictures).toEqual([{ name: 'two.webp', src: '/media/c/two.webp/f0/sig' }])
  })

  it('opens a message\'s pictures as the viewer\'s files, in order', () => {
    const files = eventImageFiles([
      { name: 'a.JPG', src: '/media/c/m/0/sig' },
      { name: 'b', dataUrl: 'data:image/webp;base64,AAAA' },
    ])
    expect(files.map(({ id, mime, kind, src }) => ({ id, mime, kind, src }))).toEqual([
      { id: 'picture:0', mime: 'image/jpeg', kind: 'image', src: '/media/c/m/0/sig' },
      { id: 'picture:1', mime: 'image/webp', kind: 'image', src: 'data:image/webp;base64,AAAA' },
    ])
  })
})
