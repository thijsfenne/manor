import type { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { apply, note, show, type } from './noteTestState'
import { applyHighlighted, applySlashItem, closeSlashMenu, filterSlashItems, moveSlashIndex, openSlashMenu, SLASH_ITEMS, slashField } from './slashMenu'

/** The note with "/" and `query` typed at the caret, one keystroke at a time. */
function typed(marked: string, query = ''): EditorState {
  let state = type(note(marked), '/')
  for (const char of query) state = type(state, char)
  return state
}

const isOpen = (state: EditorState) => state.field(slashField) !== null

describe('where "/" opens the menu', () => {
  it('opens at the start of a line and after a space', () => {
    expect(isOpen(typed('‸'))).toBe(true)
    expect(isOpen(typed('hello ‸'))).toBe(true)
    expect(isOpen(typed('- ‸'))).toBe(true)
  })

  it('stays closed after a letter, in code, in the frontmatter and in a link target', () => {
    expect(isOpen(typed('and‸'))).toBe(false)
    expect(isOpen(typed('```\n‸\n```'))).toBe(false)
    expect(isOpen(typed('a `b ‸c` d'))).toBe(false)
    expect(isOpen(typed('---\ntitle: a ‸\n---\nbody'))).toBe(false)
    expect(isOpen(typed('[a](<b ‸c>)'))).toBe(false)
  })

  it('stays closed while an input method is composing, and for a paste', () => {
    expect(isOpen(type(note('‸'), '/', 'input.type.compose'))).toBe(false)
    expect(isOpen(type(note('‸'), '/', 'input.paste'))).toBe(false)
  })

  it('opens when "/" and its query arrive in one fast burst', () => {
    const state = type(note('‸'), '/divi')
    expect(openSlashMenu(state)?.items[0]?.id).toBe('divider')
    expect(isOpen(type(note('‸'), 'and/or'))).toBe(false)
  })

  it('does not open when the caret only moves next to an old "/"', () => {
    const state = note('a /h‸')
    expect(isOpen(state.update({ selection: { anchor: 3 } }).state)).toBe(false)
  })

  it('closes when the caret leaves the query or the "/" is deleted', () => {
    const open = typed('‸', 'he')
    expect(isOpen(open.update({ selection: { anchor: 0 } }).state)).toBe(false)
    expect(isOpen(open.update({ changes: { from: 0, to: 1 } }).state)).toBe(false)
  })
})

describe('filtering', () => {
  it('filters by name and keywords, best match first', () => {
    expect(filterSlashItems('head').map((item) => item.id)).toEqual(['h1', 'h2', 'h3'])
    expect(filterSlashItems('todo').map((item) => item.id)).toEqual(['todo'])
    expect(filterSlashItems('hr').map((item) => item.id)).toEqual(['divider'])
    expect(filterSlashItems('').length).toBe(SLASH_ITEMS.length)
    expect(filterSlashItems('zzz')).toEqual([])
  })

  it('reads the query from the note and hides when nothing matches', () => {
    expect(openSlashMenu(typed('‸', 'num'))?.items.map((item) => item.id)).toEqual(['number'])
    expect(openSlashMenu(typed('‸', 'zzz'))).toBeNull()
  })

  it('moves the highlight with wrapping and closes on Escape, leaving the text', () => {
    let state = typed('‸', 'head')
    state = apply(state, moveSlashIndex(state, -1))
    expect(openSlashMenu(state)?.index).toBe(2)
    state = apply(state, closeSlashMenu(state))
    expect(isOpen(state)).toBe(false)
    expect(show(state)).toBe('/head‸')
  })
})

describe('applying an item', () => {
  const pick = (marked: string, id: string, query = id) => {
    const state = typed(marked, query)
    const item = SLASH_ITEMS.find((entry) => entry.id === id)!
    const after = apply(state, applySlashItem(state, item))
    expect(isOpen(after)).toBe(false)
    return show(after)
  }

  it.each([
    ['text', '‸'],
    ['h1', '# ‸'],
    ['h2', '## ‸'],
    ['h3', '### ‸'],
    ['bullet', '- ‸'],
    ['number', '1. ‸'],
    ['todo', '- [ ] ‸'],
    ['quote', '> ‸'],
    ['divider', '---\n‸'],
    ['code', '```\n‸\n```'],
    ['callout', '> [!note]\n> ‸'],
    ['table', '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\n‸'],
  ])('turns an empty line into %s', (id, expected) => {
    expect(pick('‸', id)).toBe(expected)
  })

  it('keeps a paragraph line apart from a divider or table so markdown still reads it', () => {
    expect(pick('para\n‸', 'divider')).toBe('para\n\n---\n‸')
    expect(pick('para\n‸', 'table', 'tab')).toBe('para\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\n‸')
  })

  it('inserts below a line that has text, removing the typed query', () => {
    expect(pick('hello ‸', 'h1')).toBe('hello\n# ‸')
    expect(pick('1. one ‸', 'number', 'num')).toBe('1. one\n2. ‸')
  })

  it('turns an empty block line into another block', () => {
    expect(pick('# ‸', 'bullet', 'bul')).toBe('- ‸')
    expect(pick('- ‸', 'h2')).toBe('## ‸')
  })

  it('keeps the quote or callout the line belongs to', () => {
    expect(pick('> [!note] T\n> one ‸', 'bullet', 'bul')).toBe('> [!note] T\n> one\n> - ‸')
    expect(pick('> ‸', 'h1')).toBe('> # ‸')
  })

  it('applies the highlighted row on Enter', () => {
    const state = typed('‸', 'quo')
    expect(show(apply(state, applyHighlighted(state)))).toBe('> ‸')
  })
})
