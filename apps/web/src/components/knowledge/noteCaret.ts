import { isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, Facet, Prec, RangeSet, RangeValue, StateField, Transaction, findClusterBreak, type Extension, type Line, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, keymap, type Command, type DecorationSet, type KeyBinding } from '@codemirror/view'
import { unwrapBlockBackward } from './blockCommands'
import { wikilinkAt } from './formatCommands'
import { codeBlockAt, frontmatterRange, inTable, linePrefix, ownStep, type SyntaxNode } from './noteSyntax'

/**
 * Where the caret may stand in a note that never shows its markdown. The live preview
 * hides every marker, so this module makes them behave like the nothing they look
 * like: the frontmatter is sealed (the property list is its only editor), the caret
 * never rests inside a line's block mark, and arrows and deletes step over hidden
 * markers as one unit instead of pausing on them invisibly.
 */

// ---------------------------------------------------------------------------
// The frontmatter, sealed

/**
 * Where the body starts: past the closing fence and its line break. A note that is
 * only frontmatter, with no break after it, starts its body at the very end.
 */
export function bodyStart(state: EditorState): number | null {
  const meta = frontmatterRange(state)
  if (meta === null) return null
  return Math.min(meta.to + 1, state.doc.length)
}

class Sealed extends RangeValue {}
const sealed = new Sealed()

/** The block, hidden whole. A block decoration, so it has to live in state. */
const sealField = StateField.define<{ hide: DecorationSet; atoms: RangeSet<Sealed> }>({
  create: (state) => seal(state),
  update: (value, tr) => (tr.docChanged ? seal(tr.state) : value),
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.hide),
    EditorView.atomicRanges.of((view) => view.state.field(field).atoms),
  ],
})

function seal(state: EditorState) {
  const meta = frontmatterRange(state)
  const start = bodyStart(state)
  if (meta === null || start === null) return { hide: Decoration.none, atoms: RangeSet.empty }
  return {
    hide: Decoration.set([Decoration.replace({ block: true }).range(meta.from, meta.to)]),
    atoms: RangeSet.of([sealed.range(0, Math.max(start, 1))]),
  }
}

/**
 * Typing, pasting, cutting or deleting never changes the frontmatter. A change that
 * reaches into it keeps its part in the body and loses the rest, so select-all and
 * type replaces the body and leaves the properties. Undo and the property list's own
 * edits (`filter: false`) pass untouched.
 */
const guardFrontmatter = EditorState.transactionFilter.of((tr): Transaction | TransactionSpec => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move'))) return tr
  const start = bodyStart(tr.startState)
  if (start === null) return tr
  const atEnd = start === tr.startState.doc.length && frontmatterRange(tr.startState)?.to === start
  let touched = false
  const changes: { from: number; to: number; insert: string }[] = []
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const insert = inserted.sliceString(0, inserted.length, tr.startState.lineBreak)
    if (fromA >= start && !(atEnd && fromA === start)) {
      changes.push({ from: fromA, to: toA, insert })
      return
    }
    touched = true
    const to = Math.max(toA, start)
    // A body that does not exist yet gets its own line, so nothing lands on the fence.
    const text = atEnd && insert !== '' ? tr.startState.lineBreak + insert : insert
    if (to > start || text !== '') changes.push({ from: start, to, insert: text })
  })
  if (!touched) return tr
  const set = tr.startState.changes(changes)
  // Typing and deleting leave a caret after what was typed; a drag keeps its range, clipped to the body.
  const collapse = !tr.isUserEvent('move')
  const clip = (pos: number) => set.mapPos(Math.max(pos, start), 1)
  const ranges = tr.startState.selection.ranges.map((range) =>
    collapse ? EditorSelection.cursor(clip(range.to)) : EditorSelection.range(clip(range.anchor), clip(range.head)))
  return {
    changes: set,
    selection: EditorSelection.create(ranges, tr.startState.selection.mainIndex),
    scrollIntoView: true,
    effects: tr.effects,
    ...(tr.annotation(Transaction.userEvent) === undefined ? {} : { userEvent: tr.annotation(Transaction.userEvent) }),
  }
})

// ---------------------------------------------------------------------------
// Block marks: the caret stands after them, never before or inside

/**
 * Where the text of a line starts when the line opens with a block mark the preview
 * hides (a heading's `#`, a list or to-do mark, a quote's `>`), or null. The parse
 * has the last word, so `2. text` continuing a paragraph is not a list.
 */
export function blockPrefixEnd(state: EditorState, line: Line): number | null {
  const prefix = linePrefix(line.text)
  if (prefix.end === 0 || (prefix.kind === 'text' && prefix.quote === '')) return null
  if (line.from < (bodyStart(state) ?? 0) || codeBlockAt(state, line) !== null || inTable(state, line)) return null
  if (pendingItem(state, line) !== null) return line.from + prefix.end
  let marked = false
  syntaxTree(state).iterate({
    from: line.from,
    to: line.from + prefix.end,
    enter: (node) => {
      if (node.from >= line.from && node.from < line.from + prefix.end && (node.name === 'ListMark' || node.name === 'HeaderMark' || node.name === 'QuoteMark')) marked = true
      return !marked
    },
  })
  return marked ? line.from + prefix.end : null
}

/**
 * Where the mark of a list item being started sits: `- ` or `1. ` with nothing after
 * it, right under a paragraph line. Markdown still reads that line as paragraph text
 * (or `-` as a heading underline) until its first character, so the preview and the
 * caret treat it as the item it is about to be. Null for any other line.
 */
export function pendingItem(state: EditorState, line: Line): number | null {
  const match = /^( {0,3})(?:[-*+]|1[.)])[ \t]+$/.exec(line.text)
  if (match === null) return null
  const from = line.from + (match[1] as string).length
  const node = syntaxTree(state).resolveInner(from, 1)
  const host = node.name === 'HeaderMark' ? node.parent : node
  return host !== null && /^(Paragraph|SetextHeading\d)$/.test(host.name) ? from : null
}

/** A resting caret that is inside the frontmatter or a block mark moves to the text. */
function settle(state: EditorState, pos: number): number {
  const start = bodyStart(state)
  if (start !== null && pos < start) return start
  const line = state.doc.lineAt(pos)
  const end = blockPrefixEnd(state, line)
  return end !== null && pos < end ? end : pos
}

const settleCarets = EditorState.transactionFilter.of((tr) => {
  if (tr.selection === undefined && !tr.docChanged) return tr
  const selection = tr.newSelection
  if (!selection.ranges.some((range) => range.empty)) return tr
  let moved = false
  const ranges = selection.ranges.map((range) => {
    if (!range.empty) return range
    const pos = settle(tr.state, range.head)
    if (pos === range.head) return range
    moved = true
    return EditorSelection.cursor(pos)
  })
  if (!moved) return tr
  return [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }]
})

// ---------------------------------------------------------------------------
// Stepping over hidden markers

/** Hidden ranges the caret treats as one unit. The live preview and the seal provide them. */
export const caretAtoms = Facet.define<(view: EditorView) => RangeSet<RangeValue>>()

function atomsOf(view: EditorView): RangeSet<RangeValue>[] {
  return [...view.state.facet(caretAtoms).map((get) => get(view)), sealAtoms(view.state)]
}

/** The sealed frontmatter as a caret atom, for callers that hold a state without a view. */
export const sealAtoms = (state: EditorState): RangeSet<RangeValue> => state.field(sealField, false)?.atoms ?? seal(state).atoms

/** From `pos`, past every hidden range that begins (forward) or ends (backward) there. */
export function skipAtoms(atoms: readonly RangeSet<RangeValue>[], pos: number, forward: boolean, limit?: number): number {
  for (let moved = true; moved;) {
    moved = false
    for (const set of atoms) {
      // Overlapping atoms (a nested list's marks) are crossed to the farthest end.
      let next = pos
      set.between(pos - 1, pos + 1, (from, to) => {
        if (from === to) return
        if (forward && from === pos && to > next && (limit === undefined || to <= limit)) next = to
        if (!forward && to === pos && from < next && (limit === undefined || from >= limit)) next = from
      })
      if (next !== pos) { pos = next; moved = true }
    }
  }
  return pos
}

/** One character (a whole grapheme, or the line break) from `pos`. */
function charStep(state: EditorState, pos: number, forward: boolean): number {
  const line = state.doc.lineAt(pos)
  if (forward) {
    if (pos === line.to) return Math.min(pos + 1, state.doc.length)
    return line.from + findClusterBreak(line.text, pos - line.from, true)
  }
  if (pos === line.from) return Math.max(pos - 1, 0)
  return line.from + findClusterBreak(line.text, pos - line.from, false)
}

/**
 * Arrow left or right where a hidden marker sits next to the caret. Both sides of a
 * hidden marker draw the caret in the same place, so a plain step would look like a
 * dead key press; this one crosses the marker and the character beyond it. Declines
 * where nothing hidden is adjacent, so CodeMirror's own motion runs.
 */
export function stepCaret(forward: boolean, extend: boolean): Command {
  return (view) => {
    const spec = caretStep(view.state, atomsOf(view), forward, extend)
    if (spec === null) return false
    view.dispatch(spec)
    return true
  }
}

/** The selection `stepCaret` moves to, or null where CodeMirror's own motion should run. */
export function caretStep(state: EditorState, atoms: readonly RangeSet<RangeValue>[], forward: boolean, extend: boolean): TransactionSpec | null {
  if (state.selection.ranges.length !== 1) return null
  const range = state.selection.main
  if (!range.empty && !extend) return null
  const skipped = skipAtoms(atoms, range.head, forward)
  if (skipped === range.head) return null
  let next = charStep(state, skipped, forward)
  // Landing on a line's block mark from above means its text, not the mark.
  if (forward) {
    const end = blockPrefixEnd(state, state.doc.lineAt(next))
    if (end !== null && next < end) next = end
  }
  if (!extend) next = settle(state, next)
  return {
    // A new selection starts past the marker it crosses, so it never holds half a link.
    selection: extend ? EditorSelection.range(range.empty ? skipped : range.anchor, next) : EditorSelection.cursor(next, forward ? -1 : 1),
    scrollIntoView: true,
    userEvent: 'select',
  }
}

/** Inline marks and links whose hidden markers must never be cut in half. */
const WRAPPERS: ReadonlySet<string> = new Set(['Emphasis', 'StrongEmphasis', 'Strikethrough', 'InlineCode', 'Link'])

interface Wrapper { from: number; to: number; contentFrom: number; contentTo: number }

function wrapperOf(node: SyntaxNode): Wrapper | null {
  const marks = node.name === 'Link' ? node.getChildren('LinkMark') : null
  const contentFrom = marks === null ? node.firstChild?.to : marks[0]?.to
  const contentTo = marks === null ? node.lastChild?.from : marks[1]?.from
  if (contentFrom === undefined || contentTo === undefined || contentTo < contentFrom) return null
  return { from: node.from, to: node.to, contentFrom, contentTo }
}

/** Wrappers that `[from, to]` cuts into without holding whole. */
function wrappersCut(state: EditorState, from: number, to: number): Wrapper[] {
  const cut: Wrapper[] = []
  const add = (wrapper: Wrapper | null) => {
    if (wrapper === null || wrapper.from >= to || wrapper.to <= from || (wrapper.from >= from && wrapper.to <= to)) return
    if (!cut.some((each) => each.from === wrapper.from && each.to === wrapper.to)) cut.push(wrapper)
  }
  syntaxTree(state).iterate({ from, to, enter: (node) => { if (WRAPPERS.has(node.name)) add(wrapperOf(node.node)) } })
  for (const pos of [from, to]) {
    const wiki = wikilinkAt(state, pos)
    if (wiki !== null) add({ from: wiki.from, to: wiki.to, contentFrom: wiki.labelFrom, contentTo: wiki.labelTo })
  }
  return cut
}

type Span = [from: number, to: number]

/** `span` with `mark` taken out: zero, one or two spans. */
function without([from, to]: Span, [markFrom, markTo]: Span): Span[] {
  if (markTo <= from || markFrom >= to) return [[from, to]]
  const kept: Span[] = []
  if (markFrom > from) kept.push([from, markFrom])
  if (markTo < to) kept.push([markTo, to])
  return kept
}

/**
 * A delete or an overtype that cuts through a bold run or a link never leaves half
 * its hidden markers behind. Deleting all of a wrapper's text takes the wrapper;
 * otherwise the markers stay and only the text goes, so `[wo|rd](url) tail` with
 * `rd tail` selected leaves the link `wo`.
 */
const keepWrappers = EditorState.transactionFilter.of((tr): Transaction | TransactionSpec => {
  if (!tr.docChanged || tr.annotation(isolateHistory) !== undefined) return tr
  if (!(tr.isUserEvent('delete') || tr.isUserEvent('input.type') || tr.isUserEvent('input.paste'))) return tr
  const parts: { fromA: number; toA: number; insert: string }[] = []
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { parts.push({ fromA, toA, insert: inserted.toString() }) })
  const [part] = parts
  if (parts.length !== 1 || part === undefined || part.toA === part.fromA) return tr
  const state = tr.startState
  let { fromA: from, toA: to } = part
  if (part.insert === '') {
    for (let grown = true; grown;) {
      grown = false
      for (const wrapper of wrappersCut(state, from, to)) {
        if (from > wrapper.contentFrom || to < wrapper.contentTo) continue
        from = Math.min(from, wrapper.from)
        to = Math.max(to, wrapper.to)
        grown = true
      }
    }
  }
  const cut = wrappersCut(state, from, to)
  let pieces: Span[] = [[from, to]]
  for (const wrapper of cut) {
    pieces = pieces.flatMap((piece) => without(piece, [wrapper.from, wrapper.contentFrom])).flatMap((piece) => without(piece, [wrapper.contentTo, wrapper.to]))
  }
  const [first] = pieces
  if (first === undefined || (pieces.length === 1 && first[0] === part.fromA && first[1] === part.toA)) return tr
  // Typed text goes inside the cut wrapper, next to its marker, so `**X two**` stays
  // bold rather than leaving `X** two**`, which markdown no longer reads as a run.
  const inside = pieces.findIndex(([a, b]) => cut.some((wrapper) => a >= wrapper.contentFrom && b <= wrapper.contentTo))
  const host = pieces[Math.max(inside, 0)] ?? first
  const set = state.changes(pieces.map((piece) => ({ from: piece[0], to: piece[1], insert: piece === host ? part.insert : '' })))
  return {
    changes: set,
    selection: EditorSelection.cursor(set.mapPos(host[0], -1) + part.insert.length),
    scrollIntoView: true,
    ...(tr.annotation(Transaction.userEvent) === undefined ? {} : { userEvent: tr.annotation(Transaction.userEvent) }),
  }
})

/**
 * Backspace or Delete next to a hidden marker deletes the visible character beyond
 * it, never the marker (`keepWrappers` then takes an emptied wrapper whole). Backspace
 * that lands at the start of a line's text hands over to the block rules (a list
 * item becomes text).
 */
export function deleteOverMarkers(forward: boolean): Command {
  return (view) => {
    const spec = markerDelete(view.state, atomsOf(view), forward)
    if (spec === null) return false
    if (spec !== 'none') view.dispatch(spec)
    return true
  }
}

/** What `deleteOverMarkers` does: a change, `none` (consumed, nothing to delete), or null. */
export function markerDelete(state: EditorState, atoms: readonly RangeSet<RangeValue>[], forward: boolean): TransactionSpec | 'none' | null {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const textStart = blockPrefixEnd(state, line) ?? line.from
  const pos = skipAtoms(atoms, head, forward, forward ? line.to : textStart)
  if (pos === head && forward && head === line.to && line.number < state.doc.lines) {
    // Joining the next line onto this one takes its block mark too, so `- item` never
    // lands mid-line as the raw `- ` it would otherwise be.
    const end = blockPrefixEnd(state, state.doc.line(line.number + 1))
    if (end === null) return null
    return { changes: { from: head, to: end }, userEvent: 'delete.forward', scrollIntoView: true, annotations: ownStep }
  }
  if (!forward && pos === textStart && textStart > line.from) {
    const moved = state.update({ selection: EditorSelection.cursor(pos) }).state
    const spec = unwrapBlockBackward(moved)
    // Composed onto the caret move, so the spec applies to the state that was asked.
    if (spec !== null) {
      const tr = moved.update(spec)
      return { changes: tr.changes, selection: tr.newSelection, userEvent: 'delete.backward', scrollIntoView: true, annotations: ownStep }
    }
  }
  const other = charStep(state, pos, forward)
  if (other === pos) return pos === head ? null : 'none'
  // Nothing hidden next to the caret: the plain delete is right.
  if (pos === head) return null
  const from = Math.min(pos, other)
  return {
    changes: { from, to: Math.max(pos, other) },
    selection: EditorSelection.cursor(from),
    userEvent: forward ? 'delete.forward' : 'delete.backward',
    scrollIntoView: true,
  }
}

const caretKeys: KeyBinding[] = [
  { key: 'ArrowLeft', run: stepCaret(false, false), shift: stepCaret(false, true) },
  { key: 'ArrowRight', run: stepCaret(true, false), shift: stepCaret(true, true) },
  { key: 'Backspace', run: deleteOverMarkers(false) },
  { key: 'Delete', run: deleteOverMarkers(true) },
]

/**
 * The seal and the caret rules. `caretKeys` sit below the block keys (Enter, Tab,
 * Backspace at a mark) and above CodeMirror's defaults.
 */
export const noteCaretExtensions = (): Extension[] => [
  sealField,
  guardFrontmatter,
  keepWrappers,
  settleCarets,
  Prec.high(keymap.of(caretKeys)),
]
