import { history } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { livePreviewExtensions } from './livePreview'
import type { NoteTransform } from './noteSyntax'

/**
 * Notes for the formatting tests, written with the selection inline: `‸` is a caret,
 * `«` and `»` are a selection's anchor and head. `show` writes a state back the same
 * way, so a test reads as before and after.
 */
export function note(marked: string): EditorState {
  const ranges: { anchor: number; head: number }[] = []
  let doc = ''
  let anchor: number | null = null
  for (const char of marked) {
    if (char === '‸') ranges.push({ anchor: doc.length, head: doc.length })
    else if (char === '«') anchor = doc.length
    else if (char === '»') {
      ranges.push({ anchor: anchor ?? doc.length, head: doc.length })
      anchor = null
    } else doc += char
  }
  const selection = ranges.length === 0
    ? EditorSelection.single(0)
    : EditorSelection.create(ranges.map((range) => EditorSelection.range(range.anchor, range.head)))
  const state = EditorState.create({ doc, selection, extensions: [history(), EditorState.allowMultipleSelections.of(true), ...livePreviewExtensions()] })
  ensureSyntaxTree(state, state.doc.length, Infinity)
  return state
}

export function show(state: EditorState): string {
  const marks: { at: number; text: string }[] = []
  for (const range of state.selection.ranges) {
    if (range.empty) marks.push({ at: range.head, text: '‸' })
    else {
      marks.push({ at: range.from, text: '«' })
      marks.push({ at: range.to, text: '»' })
    }
  }
  let doc = state.doc.toString()
  for (const mark of marks.sort((a, b) => b.at - a.at || (a.text === '»' ? -1 : 1))) doc = doc.slice(0, mark.at) + mark.text + doc.slice(mark.at)
  return doc
}

/** The state after `spec`, or the same state when the transform declined. */
export function apply(state: EditorState, spec: TransactionSpec | null): EditorState {
  return spec === null ? state : state.update(spec).state
}

/** `transform` on a marked note, written back marked. Null when it declined. */
export function run(marked: string, transform: NoteTransform): string | null {
  const state = note(marked)
  const spec = transform(state)
  return spec === null ? null : show(apply(state, spec))
}

/** Typing `text` at the caret as the keyboard would, so input-driven state reacts. */
export function type(state: EditorState, text: string, userEvent = 'input.type'): EditorState {
  const at = state.selection.main.head
  return state.update({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent }).state
}
