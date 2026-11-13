import { describe, expect, it } from 'vitest'

import { buildNoteIndex, readWikilink, resolveNote } from './vaultNotes'

describe('the note index', () => {
  const paths = [
    'meetings/2026-05-28-design-team-block.md',
    'people/robin.md',
    'research/wiki/context-engineering.md',
    'archive/people/robin.md',
  ]
  const index = buildNoteIndex(paths)

  it('resolves a bare name, whatever its case', () => {
    expect(resolveNote(index, 'context-engineering')).toBe('research/wiki/context-engineering.md')
    expect(resolveNote(index, 'Context-Engineering')).toBe('research/wiki/context-engineering.md')
  })

  it('resolves a path prefix and an explicit extension', () => {
    expect(resolveNote(index, 'wiki/context-engineering')).toBe('research/wiki/context-engineering.md')
    expect(resolveNote(index, 'people/robin.md')).toBe('people/robin.md')
  })

  it('gives an ambiguous name to the shallower note, the way Obsidian does', () => {
    expect(resolveNote(index, 'robin')).toBe('people/robin.md')
    expect(resolveNote(index, 'archive/people/robin')).toBe('archive/people/robin.md')
  })

  it('opens the note a heading link points into, and refuses a name it has never seen', () => {
    expect(resolveNote(index, 'robin#Role')).toBe('people/robin.md')
    expect(resolveNote(index, 'no-such-note')).toBeNull()
  })
})

describe('who may build an index', () => {
  /**
   * The index takes paths, not notes, so it will happily make a source file
   * reachable. That is why only a surface that knows it is standing in a vault may
   * build one; a repo listing handed to it turns every filename into a link target.
   */
  it('indexes whatever it is handed, which is why a repo listing may not be', () => {
    const repo = buildNoteIndex(['apps/server/src/main.ts', 'docs/decisions/INDEX.md'])
    expect(resolveNote(repo, 'main.ts')).toBe('apps/server/src/main.ts')
  })

  it('resolves nothing at all without a listing', () => {
    expect(resolveNote(buildNoteIndex([]), 'robin')).toBeNull()
  })
})

describe('readWikilink', () => {
  it('reads a bare link as its own label', () => {
    expect(readWikilink('context-engineering')).toEqual({
      target: 'context-engineering',
      label: 'context-engineering',
    })
  })

  it('keeps the alias as the label and trims both halves', () => {
    expect(readWikilink(' people/robin | Robin ')).toEqual({ target: 'people/robin', label: 'Robin' })
  })

  it('refuses a pair of brackets with an empty half, which is not a link', () => {
    expect(readWikilink('robin|')).toBeNull()
    expect(readWikilink('|Robin')).toBeNull()
    expect(readWikilink('   ')).toBeNull()
  })
})
