import { describe, expect, it } from 'vitest'
import { basename, dirname, entriesUnder, parentOf, resolveRelativeFileLink, singleRootDir } from './fileTree'

const files = ['Manor/README.md', 'Manor/src/app.ts', 'Manor/src/lib/a.ts', 'Manor/src/lib/b.ts', 'Archive/soul.md']

describe('entriesUnder', () => {
  it('lists the top level with folders first', () => {
    expect(entriesUnder(files, '')).toEqual([
      { kind: 'folder', name: 'Archive', path: 'Archive', count: 1 },
      { kind: 'folder', name: 'Manor', path: 'Manor', count: 4 },
    ])
  })
  it('lists one level down, files after folders, counting through every level', () => {
    expect(entriesUnder(files, 'Manor')).toEqual([
      { kind: 'folder', name: 'src', path: 'Manor/src', count: 3 },
      { kind: 'file', name: 'README.md', path: 'Manor/README.md', count: 1 },
    ])
    expect(entriesUnder(files, 'Manor/src/lib').map((entry) => entry.name)).toEqual(['a.ts', 'b.ts'])
  })
  it('does not confuse a folder with a longer name sharing its prefix', () => {
    expect(entriesUnder(['a/x.ts', 'ab/y.ts'], 'a')).toEqual([{ kind: 'file', name: 'x.ts', path: 'a/x.ts', count: 1 }])
  })
  it('sorts case-insensitively', () => {
    expect(entriesUnder(['r/b.ts', 'r/A.ts', 'r/c.ts'], 'r').map((entry) => entry.name)).toEqual(['A.ts', 'b.ts', 'c.ts'])
  })
  it('finds the display root only when one linked folder wraps the listing', () => {
    expect(singleRootDir(['Manor/README.md', 'Manor/src/app.ts'])).toBe('Manor')
    expect(singleRootDir(['Manor/README.md', 'Archive/soul.md'])).toBe('')
    expect(singleRootDir([])).toBe('')
  })
})

describe('path helpers', () => {
  it('walks up and names', () => {
    expect(parentOf('a/b/c')).toBe('a/b')
    expect(parentOf('a')).toBe('')
    expect(basename('a/b/c.ts')).toBe('c.ts')
    expect(dirname('a/b/c.ts')).toBe('a/b')
    expect(dirname('c.ts')).toBe('')
  })

  it('resolves Markdown links beside their source file without escaping the listing', () => {
    expect(resolveRelativeFileLink('Manor/BRIEFING.md', 'docs/decisions/INDEX.md')).toBe('Manor/docs/decisions/INDEX.md')
    expect(resolveRelativeFileLink('Manor/docs/decisions/INDEX.md', '../BRIEFING%20NOTES.md#context')).toBe('Manor/docs/BRIEFING NOTES.md')
    expect(resolveRelativeFileLink('Manor/BRIEFING.md', '../../secret.md')).toBeNull()
    expect(resolveRelativeFileLink('Manor/BRIEFING.md', 'https://example.com/doc')).toBeNull()
    expect(resolveRelativeFileLink('Manor/BRIEFING.md', '#section')).toBeNull()
  })
})
