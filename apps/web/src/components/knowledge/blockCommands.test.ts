import { undo } from '@codemirror/commands'
import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'
import { EditorState, type StateCommand } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { exitEmptyQuote, indentList, insertBlock, moveLines, todoTrigger, turnInto, unwrapBlockBackward } from './blockCommands'
import { noteEditingExtensions } from './noteEditing'
import { apply, note, run, show } from './noteTestState'

function command(marked: string, cmd: StateCommand): string {
  let state: EditorState = note(marked)
  cmd({ state, dispatch: (tr) => { state = tr.state } })
  return show(state)
}

describe('Turn into', () => {
  it.each([
    ['h1', '# ‸hello'],
    ['h2', '## ‸hello'],
    ['h3', '### ‸hello'],
    ['bullet', '- ‸hello'],
    ['number', '1. ‸hello'],
    ['todo', '- [ ] ‸hello'],
    ['quote', '> ‸hello'],
    ['code', '```\n‸hello\n```'],
  ] as const)('turns a plain line into %s', (kind, expected) => {
    expect(run('‸hello', turnInto(kind))).toBe(expected)
  })

  it('declines a line that already is the block', () => {
    expect(run('‸hello', turnInto('text'))).toBeNull()
    expect(run('# ‸hello', turnInto('h1'))).toBeNull()
  })

  it('rewrites an already formatted line rather than stacking marks', () => {
    expect(run('# ‸hello', turnInto('bullet'))).toBe('- ‸hello')
    expect(run('- [x] ‸done', turnInto('text'))).toBe('‸done')
    expect(run('- [x] ‸done', turnInto('bullet'))).toBe('- ‸done')
    expect(run('1. ‸one', turnInto('todo'))).toBe('- [ ] ‸one')
    expect(run('> ‸said', turnInto('h2'))).toBe('> ## ‸said')
    expect(run('> [!note] ‸Title', turnInto('text'))).toBe('‸Title')
    expect(run('  - ‸nested', turnInto('number'))).toBe('  1. ‸nested')
  })

  it('applies to every line the selection touches, skipping blank ones', () => {
    expect(run('«one\ntwo\n\nthree»', turnInto('number'))).toBe('1. «one\n2. two\n\n3. three»')
    expect(run('«# one\n- two»', turnInto('text'))).toBe('«one\ntwo»')
    expect(run('«one\ntwo»', turnInto('code'))).toBe('```\n«one\ntwo»\n```')
  })

  it('continues the numbering of the list above', () => {
    expect(run('1. a\n2. b\n‸c', turnInto('number'))).toBe('1. a\n2. b\n3. ‸c')
  })

  it('declines every kind inside a fenced block, Mod-Alt-0 included', () => {
    expect(run('```js\n‸a\nb\n```', turnInto('text'))).toBeNull()
    expect(run('```\n‸a\n```', turnInto('h1'))).toBeNull()
    expect(run('```js\n«a\nb»\n```', turnInto('bullet'))).toBeNull()
    expect(run('```js\n‸a\nb\n```', turnInto('code'))).toBeNull()
  })

  it('toggles a fence off with Code over the whole block, text kept byte for byte', () => {
    expect(run('```js\n«  a *b*\n\tc»\n```', turnInto('code'))).toBe('«  a *b*\n\tc»')
    expect(run('«```js\n  a\n```»', turnInto('code'))).toBe('«  a»')
    expect(run('```js\n«a\nb»\nc\n```', turnInto('code'))).toBeNull()
  })

  it('keeps the quote or callout a line belongs to', () => {
    expect(run('> [!note] T\n> on‸e\n> two', turnInto('bullet'))).toBe('> [!note] T\n> - on‸e\n> two')
    expect(run('> - a‸', turnInto('h1'))).toBe('> # a‸')
    expect(run('> 1. a\n> b‸', turnInto('number'))).toBe('> 1. a\n> 2. b‸')
  })

  it('takes the inner mark off with Text, then the quote; Quote on a quote is a toggle', () => {
    expect(run('> - a‸', turnInto('text'))).toBe('> a‸')
    expect(run('> a‸', turnInto('text'))).toBe('a‸')
    expect(run('> - a‸', turnInto('quote'))).toBe('- a‸')
    expect(run('> a‸', turnInto('quote'))).toBe('a‸')
    expect(run('«> a\nb»', turnInto('quote'))).toBe('«> a\n> b»')
  })

  it('leaves frontmatter and tables alone', () => {
    expect(run('---\n‸k: v\n---', turnInto('h1'))).toBeNull()
  })

  it('is one undo step, renumbering included', () => {
    const state = note('1. a\n‸b\n2. c')
    const after = apply(state, turnInto('number')(state))
    expect(after.doc.toString()).toBe('1. a\n2. b\n3. c')
    let undone = after
    undo({ state: after, dispatch: (tr) => { undone = tr.state } })
    expect(undone.doc.toString()).toBe('1. a\nb\n2. c')
  })
})

describe('renumbering leaves the lists the user did not touch', () => {
  it('continues a list markdown joins across a blank line, without rewriting it', () => {
    expect(run('3. a\n4. b\n\npara‸', turnInto('number'))).toBe('3. a\n4. b\n\n5. para‸')
  })

  it('keeps zero padded digits', () => {
    expect(run('01. a\n02. b\nc‸', turnInto('number'))).toBe('01. a\n02. b\n03. c‸')
  })

  it('uses the list\'s own delimiter', () => {
    expect(run('1) a\n2) b\nc‸', turnInto('number'))).toBe('1) a\n2) b\n3) c‸')
  })

  it('keeps a lazily numbered list lazy', () => {
    expect(run('1. a\n1. b\npara‸', turnInto('number'))).toBe('1. a\n1. b\n1. para‸')
  })

  it('applies the same rule to a move, an indent and a deletion', () => {
    expect(run('01. a\n02. ‸b', moveLines('up'))).toBe('01. ‸b\n02. a')
    expect(run('1) a\n2) ‸b\n3) c', indentList(1))).toBe('1) a\n   1) ‸b\n2) c')
    const state = note('3. a\n4. b\n5. c')
    const deleted = state.update({ changes: { from: 5, to: 10 }, userEvent: 'delete.backward' }).state
    expect(deleted.doc.toString()).toBe('3. a\n4. c')
  })

  it('continues the delimiter when the slash menu adds a numbered item below', () => {
    expect(run('1) a‸', insertBlock('number'))).toBe('1) a\n2) ‸')
  })
})

describe('list indent', () => {
  it('indents under the item above and outdents back', () => {
    expect(run('- a\n- ‸b', indentList(1))).toBe('- a\n  - ‸b')
    expect(run('- a\n  - ‸b', indentList(-1))).toBe('- a\n- ‸b')
    expect(run('- [ ] a\n- [ ] ‸b', indentList(1))).toBe('- [ ] a\n  - [ ] ‸b')
  })

  it('moves an item with its children', () => {
    expect(run('- a\n- ‸b\n  - c', indentList(1))).toBe('- a\n  - ‸b\n    - c')
  })

  it('cannot nest the first item or outdent a top-level one, but keeps the key', () => {
    expect(run('- ‸a', indentList(1))).toBe('- ‸a')
    expect(run('- ‸a', indentList(-1))).toBe('- ‸a')
  })

  it('lets Tab go elsewhere outside a list and never types a tab', () => {
    expect(run('plain ‸text', indentList(1))).toBeNull()
  })

  it('renumbers both levels of a numbered list', () => {
    expect(run('1. a\n2. ‸b\n3. c', indentList(1))).toBe('1. a\n   1. ‸b\n2. c')
    expect(run('1. a\n   1. ‸b\n2. c', indentList(-1))).toBe('1. a\n2. ‸b\n3. c')
  })
})

describe('typing rules', () => {
  it('turns [] and a space into a to-do', () => {
    const at = (marked: string) => {
      const state = note(marked)
      const pos = state.selection.main.head
      const spec = todoTrigger(state, pos, pos, ' ')
      return spec === null ? null : show(apply(state, spec))
    }
    expect(at('[]‸')).toBe('- [ ] ‸')
    expect(at('  - []‸')).toBe('  - [ ] ‸')
    expect(at('a []‸')).toBeNull()
    expect(at('```\n[]‸\n```')).toBeNull()
  })

  it('turns a fast burst of typing that holds [] and a space into a to-do', () => {
    const burst = (marked: string, text: string) => {
      const state = note(marked)
      const pos = state.selection.main.head
      const spec = todoTrigger(state, pos, pos, text)
      return spec === null ? null : show(apply(state, spec))
    }
    expect(burst('‸', '[] first')).toBe('- [ ] first‸')
    expect(burst('[‸', '] go')).toBe('- [ ] go‸')
    expect(burst('[] ‸', 'x y')).toBeNull()
    expect(burst('‸', 'a [] b')).toBeNull()
  })

  it('continues a list, a numbered list and a to-do on Enter, and leaves on an empty item', () => {
    const enter = insertNewlineContinueMarkupCommand({ nonTightLists: false })
    expect(command('- a‸', enter)).toBe('- a\n- ‸')
    expect(command('1. a‸\n2. b', enter)).toBe('1. a\n2. ‸\n3. b')
    expect(command('- [x] done‸', enter)).toBe('- [x] done\n- [ ] ‸')
    expect(command('- a\n- ‸', enter)).toBe('- a\n‸')
    expect(command('- [ ] a\n- [ ] ‸', enter)).toBe('- [ ] a\n‸')
    expect(command('- a\n  - ‸', enter)).toBe('- a\n- ‸')
  })

  it('leaves a quote on Enter at an empty quote line', () => {
    expect(run('> a\n> ‸', exitEmptyQuote)).toBe('> a\n‸')
    expect(run('> a‸', exitEmptyQuote)).toBeNull()
  })

  it('adds an empty quote line instead of leaving when the quote goes on below', () => {
    expect(run('> a\n>‸\n> b', exitEmptyQuote)).toBe('> a\n>\n>‸\n> b')
    expect(run('> [!note] T\n> ‸\n> tail', exitEmptyQuote)).toBe('> [!note] T\n> \n> ‸\n> tail')
  })

  it('removes the block mark on Backspace before it joins lines', () => {
    expect(run('# ‸Title', unwrapBlockBackward)).toBe('‸Title')
    expect(run('- ‸item', unwrapBlockBackward)).toBe('‸item')
    expect(run('- [ ] ‸task', unwrapBlockBackward)).toBe('‸task')
    expect(run('> ‸said', unwrapBlockBackward)).toBe('‸said')
    expect(run('> [!tip] ‸Title', unwrapBlockBackward)).toBe('‸Title')
    expect(run('- a\n  - ‸nested', unwrapBlockBackward)).toBe('- a\n- ‸nested')
    expect(run('# Ti‸tle', unwrapBlockBackward)).toBeNull()
    expect(run('‸plain', unwrapBlockBackward)).toBeNull()
  })

  it('renumbers after a mark is removed or a line is deleted', () => {
    expect(run('1. a\n2. ‸b\n3. c', unwrapBlockBackward)).toBe('1. a\n‸b\n2. c')
    const state = note('1. a\n2. b\n3. c')
    const deleted = state.update({ changes: { from: 5, to: 10 }, userEvent: 'delete.backward' }).state
    expect(deleted.doc.toString()).toBe('1. a\n2. c')
  })

  it('leaves a lazily numbered list as it was written', () => {
    const state = note('1. a\n1. b\n1. c')
    const deleted = state.update({ changes: { from: 5, to: 10 }, userEvent: 'delete.backward' }).state
    expect(deleted.doc.toString()).toBe('1. a\n1. c')
  })
})

describe('moving and duplicating lines', () => {
  it('moves the current line and renumbers the list it is in', () => {
    expect(run('a\n‸b\nc', moveLines('up'))).toBe('‸b\na\nc')
    expect(run('‸a\nb\nc', moveLines('down'))).toBe('b\n‸a\nc')
    expect(run('1. a\n2. ‸b', moveLines('up'))).toBe('1. ‸b\n2. a')
    expect(run('«a\nb»\nc', moveLines('down'))).toBe('c\n«a\nb»')
  })

  it('moves lines on Alt-Arrow and leaves Mod-Shift-Arrow to macOS selection', () => {
    const keys = EditorState.create({ extensions: noteEditingExtensions() }).facet(keymap).flat().map((binding) => binding.key)
    expect(keys).toContain('Alt-ArrowUp')
    expect(keys).toContain('Alt-ArrowDown')
    expect(keys).not.toContain('Mod-Shift-ArrowUp')
    expect(keys).not.toContain('Mod-Shift-ArrowDown')
  })

  it('refuses to move into the frontmatter or past the edge, without falling through', () => {
    expect(run('---\nk: v\n---\n‸a', moveLines('up'))).toBe('---\nk: v\n---\n‸a')
    expect(run('‸a', moveLines('up'))).toBe('‸a')
  })
})
