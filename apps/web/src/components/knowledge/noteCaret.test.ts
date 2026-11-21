import { history, undo } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { lineBreakOf } from '../ui/TextEditor'
import { livePreviewAtoms, livePreviewDecorationSet, livePreviewExtensions } from './livePreview'
import { caretStep, markerDelete, sealAtoms, skipAtoms } from './noteCaret'

function note(doc: string, at?: number) {
  const state = EditorState.create({ doc, extensions: [history(), ...livePreviewExtensions()] })
  ensureSyntaxTree(state, state.doc.length, 5000)
  const parsed = state.update({}).state
  return at === undefined ? parsed : parsed.update({ selection: { anchor: at } }).state
}

const atoms = (state: EditorState) => [livePreviewAtoms(state), sealAtoms(state)]

function arrow(state: EditorState, forward: boolean, extend = false) {
  const spec = caretStep(state, atoms(state), forward, extend)
  return spec === null ? null : state.update(spec).state
}

/** Backspace or Delete as the keymap runs it: the marker rule, else CodeMirror's own delete. */
function erase(state: EditorState, forward = false) {
  const spec = markerDelete(state, atoms(state), forward)
  if (spec === 'none') return null
  if (spec !== null) return state.update(spec as TransactionSpec).state
  const range = state.selection.main
  const from = range.empty ? range.head - (forward ? 0 : 1) : range.from
  const to = range.empty ? range.head + (forward ? 1 : 0) : range.to
  return state.update({ changes: { from, to }, userEvent: forward ? 'delete.forward' : 'delete.backward' }).state
}

const select = (state: EditorState, anchor: number, head: number) => state.update({ selection: EditorSelection.range(anchor, head) }).state
const type = (state: EditorState, text: string) => state.update(state.replaceSelection(text), { userEvent: 'input.type' } as TransactionSpec).state

const caret = (state: EditorState | null) => state?.selection.main.head

describe('hidden markers are atomic for the caret', () => {
  it('crosses a bold run a visible character at a time', () => {
    // `**bold** x`: the caret never pauses on either side of a hidden `**`.
    expect(caret(arrow(note('**bold** x', 0), true))).toBe(3)
    expect(caret(arrow(note('**bold** x', 6), true))).toBe(9)
    expect(caret(arrow(note('**bold** x', 8), false))).toBe(5)
    // Away from a marker, CodeMirror's own motion runs.
    expect(arrow(note('**bold** x', 3), true)).toBeNull()
  })

  it('crosses a link label and its hidden destination', () => {
    const doc = 'a [text](https://e.com) b'
    const end = doc.indexOf('](')
    expect(caret(arrow(note(doc, end), true))).toBe(doc.indexOf(' b') + 1)
    expect(caret(arrow(note(doc, doc.indexOf(' b')), false))).toBe(end - 1)
  })

  it('extends a selection over a marker with Shift', () => {
    const state = arrow(note('**bold** x', 6), true, true)
    expect(state?.selection.main.anchor).toBe(8)
    expect(state?.selection.main.head).toBe(9)
  })

  it('steps from a list item’s text to the line above in one press, and back to the text', () => {
    const doc = 'Intro\n- item'
    expect(caret(arrow(note(doc, doc.indexOf('item')), false))).toBe(doc.indexOf('\n'))
    // Right from the end of the line above lands on the item text, past the hidden mark.
    const state = note(doc, doc.indexOf('\n')).update({ selection: { anchor: doc.indexOf('\n') + 1 } }).state
    expect(caret(state)).toBe(doc.indexOf('item'))
  })

  it('Backspace past a hidden marker deletes the visible character, not the marker', () => {
    const state = erase(note('**bold** x', 8))
    expect(state?.doc.toString()).toBe('**bol** x')
    expect(caret(state)).toBe(5)
  })

  it('takes the markers with the last character of a bold run or link', () => {
    expect(erase(note('a **b** c', 7))?.doc.toString()).toBe('a  c')
    expect(erase(note('a **b** c', 5))?.doc.toString()).toBe('a  c')
    expect(erase(note('a [b](https://e.com) c', 4))?.doc.toString()).toBe('a  c')
    expect(erase(note('a [[n|b]] c', 7))?.doc.toString()).toBe('a  c')
  })

  it('starts a Shift selection past the marker it crosses', () => {
    const doc = 'a [word](u) c'
    const state = arrow(note(doc, 2), true, true)
    expect(state?.selection.main.anchor).toBe(3)
    expect(erase(state!)?.doc.toString()).toBe('a [ord](u) c')
  })

  it('a selection cut through a link or a bold run keeps the markers it does not empty', () => {
    const doc = 'a [word](https://e.com) tail'
    expect(erase(select(note(doc), 5, doc.indexOf('tail') + 2))?.doc.toString()).toBe('a [wo](https://e.com)il')
    expect(erase(select(note(doc), 3, doc.indexOf('tail') + 2))?.doc.toString()).toBe('a il')
    expect(erase(select(note('a **b** c'), 4, 5))?.doc.toString()).toBe('a  c')
    expect(type(select(note('a **bold** c'), 4, 8), 'x').doc.toString()).toBe('a **x** c')
    expect(type(select(note('a **bold** tail'), 6, 13), 'x').doc.toString()).toBe('a **box**il')
    // Typing over plain text into a run lands inside the run, so its markers stay valid.
    expect(type(select(note('a **one two**'), 0, 7), 'X').doc.toString()).toBe('**X two**')
    expect(type(select(note('a _word_ tail'), 0, 4), 'X').doc.toString()).toBe('_Xord_ tail')
  })

  it('crosses overlapping marks to their farthest end', () => {
    // `- - nested` is a list inside a list item, so both marks hide from the line start.
    const state = note('- - nested')
    expect(skipAtoms(atoms(state), 0, true)).toBe(4)
  })

  it('Backspace at an item’s text start, even behind a hidden marker, turns the item into text', () => {
    const doc = '- **bold**'
    expect(erase(note(doc, 4))?.doc.toString()).toBe('**bold**')
  })

  it('Delete at a line end takes the next line’s list mark with the join', () => {
    expect(erase(note('one\n- two', 3), true)?.doc.toString()).toBe('onetwo')
  })

  it('every hidden range is a replace decoration the atoms also hold', () => {
    const state = note('# Title\n- [ ] task **b** [l](u) [[n|label]]', 0)
    let replaced = 0
    livePreviewDecorationSet(state).between(0, state.doc.length, (_from, _to, deco) => {
      if (deco.spec.attributes === undefined && deco.spec.class === undefined && (deco.spec.widget !== undefined || _to > _from)) replaced += 1
    })
    let atomic = 0
    livePreviewAtoms(state).between(0, state.doc.length, () => { atomic += 1 })
    expect(atomic).toBe(replaced)
  })
})

describe('the caret never rests inside a block mark', () => {
  it('moves a caret placed before a bullet, a to-do box or a heading mark to the text', () => {
    expect(caret(note('- item', 0))).toBe(2)
    expect(caret(note('- [ ] task', 1))).toBe(6)
    expect(caret(note('## Heading', 0))).toBe(3)
    // A paragraph continuation that only looks like a list is text.
    expect(caret(note('Para\n2. not a list', 5))).toBe(5)
  })
})

describe('the frontmatter is sealed', () => {
  const doc = '---\ntype: note\ntags: [a]\n---\nBody text'
  const body = doc.indexOf('Body')

  it('moves a caret placed in the frontmatter to the body', () => {
    expect(caret(note(doc, 0))).toBe(body)
    expect(caret(note(doc, 8))).toBe(body)
    // Left from the body's first character goes nowhere.
    expect(caret(arrow(note(doc, body), false))).toBe(body)
  })

  it('keeps the frontmatter when select-all is typed over or cut', () => {
    const all = note(doc).update({ selection: EditorSelection.range(0, doc.length) }).state
    const typed = all.update(all.replaceSelection('New'), { userEvent: 'input.type' } as TransactionSpec)
    expect(typed.state.doc.toString()).toBe('---\ntype: note\ntags: [a]\n---\nNew')
    const cut = all.update({ changes: { from: 0, to: doc.length }, userEvent: 'delete.cut' })
    expect(cut.state.doc.toString()).toBe('---\ntype: note\ntags: [a]\n---\n')
  })

  it('types over select-all one keystroke after another', () => {
    let state = note(doc).update({ selection: EditorSelection.range(0, doc.length) }).state
    for (const key of ['A', 'B', 'C']) state = type(state, key)
    expect(state.doc.toString()).toBe('---\ntype: note\ntags: [a]\n---\nABC')
    expect(state.selection.main.empty).toBe(true)
  })

  it('does not let Backspace at the body start eat the closing fence', () => {
    const state = note(doc, body)
    const tr = state.update({ changes: { from: body - 1, to: body }, userEvent: 'delete.backward' })
    expect(tr.state.doc.toString()).toBe(doc)
  })

  it('gives typing in a note that is only frontmatter its own line', () => {
    const only = '---\ntype: note\n---'
    const state = note(only, 0)
    expect(caret(state)).toBe(only.length)
    const tr = state.update({ changes: { from: only.length, insert: 'Hi' }, userEvent: 'input.type' })
    expect(tr.state.doc.toString()).toBe(`${only}\nHi`)
  })

  it('lets undo restore it', () => {
    const state = note(doc).update({ changes: { from: 4, to: 8, insert: 'kind' }, filter: false }).state
    let restored = state
    undo({ state, dispatch: (tr) => { restored = tr.state } })
    expect(restored.doc.toString()).toBe(doc)
  })
})

describe('an untouched note keeps its bytes', () => {
  const fixtures = {
    lf: '---\ntype: note\ntags:\n  - a\n---\n# Title\n\n- [ ] task with **bold** and [a link](https://e.com)\n1. one\n> quote [[Note|alias]]\n\n```js\ncode\n```\n',
    crlf: '---\r\ntype: note\r\n---\r\n# Title\r\n- item\r\n',
    noFinalNewline: 'Plain text, `code`, ~~gone~~',
  }

  for (const [name, text] of Object.entries(fixtures)) {
    it(`round-trips ${name} through opening, caret moves and rendering`, () => {
      let state = note(text)
      for (let at = 0; at <= state.doc.length; at += 1) {
        const tr = state.update({ selection: { anchor: at }, userEvent: 'select' })
        expect(tr.docChanged).toBe(false)
        state = tr.state
        livePreviewDecorationSet(state, [state.doc.lineAt(at).number])
      }
      // What the editor writes back on its first change, here with no change at all.
      expect(state.doc.sliceString(0, state.doc.length, lineBreakOf(text))).toBe(text)
    })
  }
})

describe('a list item started right under a paragraph', () => {
  it('is a bullet from its space on, and Backspace takes the mark', () => {
    for (const doc of ['Intro\n- ', 'Intro\n1. ']) {
      const state = note(doc, doc.length)
      let widgets = 0
      livePreviewDecorationSet(state).between(doc.indexOf('\n') + 1, doc.length, (_f, _t, deco) => { if (deco.spec.widget !== undefined) widgets += 1 })
      expect(widgets).toBe(1)
      expect(erase(state)?.doc.toString()).toBe('Intro\n')
    }
    // A later item number, or a mark indented into the paragraph, stays text as markdown reads it.
    expect(livePreviewAtoms(note('Intro\n2. ')).size).toBe(0)
    expect(livePreviewAtoms(note('Intro\n    - ')).size).toBe(0)
  })
})
