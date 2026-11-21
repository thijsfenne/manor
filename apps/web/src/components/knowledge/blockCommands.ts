import { moveLineDown, moveLineUp } from '@codemirror/commands'
import { EditorSelection, type ChangeSet, type ChangeSpec, type StateCommand, type EditorState, type Line, type Transaction, type TransactionSpec } from '@codemirror/state'
import {
  chain,
  codeBlockAt,
  enclosing,
  inFrontmatter,
  inTable,
  isRule,
  linePrefix,
  LIST_KINDS,
  noteTree,
  ownStep,
  touchedLines,
  type BlockKind,
  type LinePrefix,
  type NoteTransform,
  type SyntaxNode,
} from './noteSyntax'

/**
 * Block commands for the note editor: Turn into, the slash menu's inserts, list
 * indent and renumbering, the typing rules and line moves. Each is a pure state
 * transformation; `noteEditing.ts` binds them to keys.
 */

const PREFIX: Record<Exclude<BlockKind, 'code' | 'number'>, string> = {
  text: '',
  h1: '# ',
  h2: '## ',
  h3: '### ',
  bullet: '- ',
  todo: '- [ ] ',
  quote: '> ',
}

/** A line that a block command may rewrite: not code, not frontmatter, not a table row, not a rule. */
function editableLine(state: EditorState, line: Line): boolean {
  return !inFrontmatter(state, line.from) && codeBlockAt(state, line) === null && !inTable(state, line) && !isRule(line.text)
}

// ---------------------------------------------------------------------------
// Renumbering

interface ItemMark {
  /** The digits of the marker. */
  from: number
  to: number
  number: number
  digits: string
}

/** How a list numbers itself, read from the document as it was before a change. */
interface ListStyle {
  start: number
  /** Zero-padded width (`01.`), or 0 when the numbers are not padded. */
  pad: number
  lazy: boolean
}

function orderedLists(state: EditorState, from: number, to: number): SyntaxNode[] {
  const lists: SyntaxNode[] = []
  noteTree(state, to + 2_000).iterate({
    from: Math.max(0, from),
    to: Math.min(state.doc.length, to),
    enter: (node) => {
      if (node.name === 'OrderedList') lists.push(node.node)
    },
  })
  return lists
}

function itemMarks(state: EditorState, list: SyntaxNode): ItemMark[] {
  const marks: ItemMark[] = []
  for (let item = list.firstChild; item !== null; item = item.nextSibling) {
    if (item.name !== 'ListItem') continue
    const mark = item.getChild('ListMark')
    if (mark === null) continue
    const digits = /^\d+/.exec(state.doc.sliceString(mark.from, mark.to))
    if (digits === null) continue
    marks.push({ from: mark.from, to: mark.from + digits[0].length, number: Number(digits[0]), digits: digits[0] })
  }
  return marks
}

const isLazy = (marks: readonly ItemMark[]) => marks.length > 1 && marks.every((mark) => mark.number === marks[0]!.number)

function styleOf(marks: readonly ItemMark[]): ListStyle {
  const first = marks[0]!
  return { start: first.number, pad: first.digits.length > 1 && first.digits.startsWith('0') ? first.digits.length : 0, lazy: isLazy(marks) }
}

/**
 * The numbers a change left out of order, put back in order, for the ordered lists
 * the change touched and no others. Items above the change keep their numbers as
 * written; each item from the change on follows the one before it. A list's start,
 * zero padding and laziness (`1. 1. 1.`, which renders numbered anyway) are read
 * from the list as the document had it, so the writer's style survives. Only digits
 * are rewritten, never a delimiter.
 */
export function renumberAfter(before: EditorState, changes: ChangeSet, after: EditorState): ChangeSpec[] {
  if (changes.empty) return []
  const written: { from: number; to: number }[] = []
  const oldByFrom = new Map<number, ListStyle>()
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    for (const list of orderedLists(before, fromA - 1, toA + 1)) {
      const marks = itemMarks(before, list)
      if (marks.length > 0) oldByFrom.set(changes.mapPos(list.from, -1), styleOf(marks))
    }
    written.push({ from: fromB, to: toB })
  })
  const isWritten = (mark: ItemMark) => written.some((range) => mark.from < range.to && mark.to > range.from)
  const inverse = changes.invert(before.doc)
  // The list in `before` whose first item is where `pos` (in `after`) came from.
  const oldOpenedAt = (pos: number): ListStyle | null => {
    const origin = inverse.mapPos(pos, 1)
    for (const list of orderedLists(before, origin, origin)) {
      const marks = itemMarks(before, list)
      if (marks[0]?.from === origin) return styleOf(marks)
    }
    return null
  }

  const specs: ChangeSpec[] = []
  const done = new Set<number>()
  for (const range of written) {
    for (const list of orderedLists(after, range.from - 1, range.to + 1)) {
      if (done.has(list.from)) continue
      done.add(list.from)
      const marks = itemMarks(after, list)
      if (marks.length === 0) continue
      const changeAt = Math.min(...written.filter((w) => w.to >= list.from - 1 && w.from <= list.to + 1).map((w) => w.from))
      const first = marks[0]!
      const old = (isWritten(first) ? null : oldOpenedAt(first.from)) ?? oldByFrom.get(list.from) ?? null
      const kept = marks.filter((mark) => !isWritten(mark))
      const lazy = old?.lazy === true || isLazy(kept)
      const pad = old?.pad ?? (first.from < changeAt ? styleOf(marks).pad : 0)
      let previous: number | null = null
      for (const mark of marks) {
        if (mark.from < changeAt) {
          previous = mark.number
          continue
        }
        const want: number = previous === null ? old?.start ?? 1 : lazy ? previous : previous + 1
        const text = String(want).padStart(pad, '0')
        if (mark.digits !== text) specs.push({ from: mark.from, to: mark.to, insert: text })
        previous = want
      }
    }
  }
  return specs
}

/** `spec`, with the renumbering it makes necessary folded into the same transaction. */
export function withRenumber(state: EditorState, spec: TransactionSpec): TransactionSpec {
  return chain(state, spec, (after, changes) => {
    const fix = renumberAfter(state, changes, after)
    return fix.length === 0 ? null : { changes: fix }
  })
}

/** For a transaction filter: the renumbering a user deletion needs, as a follow-up spec. */
export function renumberFollowUp(tr: Transaction): TransactionSpec | null {
  if (!tr.docChanged) return null
  const fix = renumberAfter(tr.startState, tr.changes, tr.state)
  return fix.length === 0 ? null : { changes: tr.state.changes(fix), sequential: true }
}

// ---------------------------------------------------------------------------
// Turn into

/** The numbered item right above `line` in the same list (same quote, same indent). */
function previousNumbered(state: EditorState, line: Line, prefix: LinePrefix): { number: number; delimiter: string } | null {
  if (line.number === 1) return null
  const above = linePrefix(state.doc.line(line.number - 1).text)
  if (above.kind !== 'number' || above.number === undefined || above.quote !== prefix.quote || above.indent !== prefix.indent) return null
  return { number: above.number, delimiter: above.delimiter ?? '.' }
}

/** The `>` markers of a quote prefix without a callout's `[!type]` token. */
const quoteMarks = (quote: string) => /^(?:>[ \t]?)*/.exec(quote)![0]

/**
 * One line's prefix rewritten to `kind`, or null when there is nothing to change.
 * A quoted line stays quoted: the new mark goes inside the quote. Text takes the
 * inner mark off first and the quote on a second go; Quote on a quoted line is a
 * toggle and takes the quote off, inner mark kept.
 */
function retarget(line: Line, kind: Exclude<BlockKind, 'code'>, number: number, delimiter: string): ChangeSpec | null {
  const prefix = linePrefix(line.text)
  const quoteFrom = line.from + prefix.indent.length
  const markerFrom = line.from + prefix.end - prefix.marker.length
  if (kind === 'quote') {
    if (prefix.quote !== '') return { from: quoteFrom, to: quoteFrom + prefix.quote.length, insert: '' }
    return { from: line.from, to: line.from + prefix.end, insert: PREFIX.quote }
  }
  if (kind === 'text') {
    if (prefix.quote === '') return prefix.kind === 'text' ? null : { from: line.from, to: line.from + prefix.end, insert: '' }
    if (prefix.marker !== '') return { from: markerFrom, to: line.from + prefix.end, insert: '' }
    return { from: line.from, to: line.from + prefix.end, insert: '' }
  }
  if (prefix.kind === kind) return null
  const mark = kind === 'number' ? `${number}${delimiter} ` : PREFIX[kind]
  // A to-do keeps its tick when it only changes list style.
  const ticked = kind === 'todo' && prefix.checked === true ? mark.replace('[ ]', '[x]') : mark
  if (prefix.quote !== '') return { from: markerFrom, to: line.from + prefix.end, insert: ticked }
  const keepIndent = LIST_KINDS.has(kind) && LIST_KINDS.has(prefix.kind)
  return { from: line.from, to: line.from + prefix.end, insert: (keepIndent ? prefix.indent : '') + ticked }
}

/**
 * Turn every line the selection touches into `kind`. Blank lines inside a longer
 * selection stay blank; code, tables, frontmatter and rules are left as they are.
 * Code wraps the touched lines in one fence. Inside a fenced block every kind is
 * declined except Code itself over the whole block, which takes the fence away and
 * keeps the text inside byte for byte.
 */
export function turnInto(kind: BlockKind): NoteTransform {
  return (state) => {
    const numbers = touchedLines(state)
    if (numbers.length === 0) return null
    const lines = numbers.map((n) => state.doc.line(n))
    const fence = codeBlockAt(state, lines[0]!)
    const sameFence = fence !== null && fence.name === 'FencedCode' && lines.every((line) => codeBlockAt(state, line)?.from === fence.from)

    if (kind === 'code') {
      if (sameFence) return coversFence(state, fence) ? unfence(state, fence) : null
      if (lines.some((line) => !editableLine(state, line))) return null
      const first = lines[0]!
      const last = lines[lines.length - 1]!
      const changes: ChangeSpec[] = lines.map((line) => ({ from: line.from, to: line.from + linePrefix(line.text).end, insert: '' }))
      changes.unshift({ from: first.from, insert: '```\n' })
      changes.push({ from: last.to, insert: '\n```' })
      const set = state.changes(changes)
      return { changes: set, selection: state.selection.map(set, 1), scrollIntoView: true, userEvent: 'input.format', annotations: ownStep }
    }

    const targets = lines.filter((line) => !(lines.length > 1 && line.text.trim() === '') && editableLine(state, line))
    // Quote over lines that are all quoted takes the quote off; otherwise it quotes the rest.
    const unquote = kind === 'quote' && targets.length > 0 && targets.every((line) => linePrefix(line.text).quote !== '')
    const changes: ChangeSpec[] = []
    let counter: number | null = null
    let delimiter = '.'
    let previous: LinePrefix | null = null
    for (const line of targets) {
      const prefix = linePrefix(line.text)
      if (kind === 'quote' && !unquote && prefix.quote !== '') continue
      const listPrefix = { ...prefix, indent: prefix.quote !== '' || LIST_KINDS.has(prefix.kind) ? prefix.indent : '' }
      if (counter === null || previous === null || previous.indent !== listPrefix.indent || previous.quote !== listPrefix.quote) {
        const above = previousNumbered(state, line, listPrefix)
        counter = (above?.number ?? 0) + 1
        delimiter = above?.delimiter ?? '.'
      } else counter += 1
      previous = listPrefix
      const change = retarget(line, kind, counter, delimiter)
      if (change !== null) changes.push(change)
    }
    if (changes.length === 0) return null
    const set = state.changes(changes)
    return withRenumber(state, {
      changes: set,
      selection: state.selection.map(set, 1),
      scrollIntoView: true,
      userEvent: 'input.format',
      annotations: ownStep,
    })
  }
}

/** Whether the main selection spans every line inside a fenced block (fences optional). */
function coversFence(state: EditorState, fence: SyntaxNode): boolean {
  const range = state.selection.main
  if (state.selection.ranges.length !== 1 || range.empty) return false
  const open = state.doc.lineAt(fence.from)
  const close = state.doc.lineAt(fence.to)
  const closed = close.number > open.number && /^\s*(`{3,}|~{3,})\s*$/.test(close.text)
  const firstInner = open.number + 1
  const lastInner = closed ? close.number - 1 : close.number
  if (lastInner < firstInner) return false
  return range.from <= state.doc.line(firstInner).from && range.to >= state.doc.line(lastInner).to
}

/** A fenced block back to ordinary lines: the fence lines go, the text between stays as it is. */
function unfence(state: EditorState, fence: SyntaxNode): TransactionSpec {
  const open = state.doc.lineAt(fence.from)
  const close = state.doc.lineAt(fence.to)
  const closed = close.number > open.number && /^\s*(`{3,}|~{3,})\s*$/.test(close.text)
  const removals: ChangeSpec[] = [{ from: open.from, to: Math.min(open.to + 1, state.doc.length) }]
  if (closed) removals.push({ from: close.from - 1, to: close.to })
  const set = state.changes(removals)
  return { changes: set, selection: state.selection.map(set), scrollIntoView: true, userEvent: 'input.format', annotations: ownStep }
}

// ---------------------------------------------------------------------------
// Inserting a block (the slash menu)

export type InsertKind = Exclude<BlockKind, 'code'> | 'code' | 'divider' | 'callout' | 'table'

const TABLE = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |'

export function canInsertBlock(state: EditorState): boolean {
  return !state.readOnly && editableLine(state, state.doc.lineAt(state.selection.main.head))
}

/**
 * The block `kind` at the caret's line. An empty line becomes the block; a line
 * with text keeps it and gets the block on a new line below, which is what Notion
 * does when you pick a block from the middle of a paragraph.
 */
export function insertBlock(kind: InsertKind): NoteTransform {
  return (state) => {
    if (!canInsertBlock(state)) return null
    const line = state.doc.lineAt(state.selection.main.head)
    const prefix = linePrefix(line.text)
    const empty = line.text.slice(prefix.end).trim() === ''

    if (kind !== 'code' && kind !== 'divider' && kind !== 'callout' && kind !== 'table') {
      if (empty) {
        const target = state.update({ selection: EditorSelection.cursor(line.from + prefix.end) }).state
        const spec = turnInto(kind)(target)
        if (spec === null) return { selection: EditorSelection.single(line.to), annotations: ownStep }
        return { ...spec, ...cursorAtEnd(target, spec, line) }
      }
      // The new line stays in the quote or callout this one belongs to.
      const quote = prefix.quote === '' ? '' : prefix.indent + quoteMarks(prefix.quote)
      const listIndent = quote === '' && LIST_KINDS.has(kind) && LIST_KINDS.has(prefix.kind) ? prefix.indent : ''
      const continues = kind === 'number' && prefix.kind === 'number' && prefix.number !== undefined
      const number = continues ? `${prefix.number! + 1}${prefix.delimiter ?? '.'} ` : '1. '
      const mark = kind === 'number' ? number : quote !== '' && kind === 'quote' ? '' : PREFIX[kind]
      const insert = `\n${quote}${listIndent}${mark}`
      return withRenumber(state, {
        changes: { from: line.to, insert },
        selection: EditorSelection.cursor(line.to + insert.length),
        scrollIntoView: true,
        userEvent: 'input.format',
        annotations: ownStep,
      })
    }

    // Blocks that markdown only recognises on their own: a rule under a paragraph
    // line would turn that line into a heading, a table under one would not parse.
    const above = empty ? (line.number > 1 ? state.doc.line(line.number - 1) : null) : line
    const gap = (kind === 'divider' || kind === 'table') && above !== null && above.text.trim() !== '' ? '\n' : ''
    let body: string
    let caret: number
    if (kind === 'divider') {
      body = `${gap}---\n`
      caret = body.length
    } else if (kind === 'table') {
      body = `${gap}${TABLE}\n\n`
      caret = body.length
    } else if (kind === 'code') {
      body = '```\n\n```'
      caret = 4
    } else {
      body = '> [!note]\n> '
      caret = body.length
    }
    const from = empty ? line.from : line.to
    const insert = empty ? body : `\n${body}`
    const offset = empty ? 0 : 1
    return {
      changes: { from, to: empty ? line.to : line.to, insert },
      selection: EditorSelection.cursor(from + offset + caret),
      scrollIntoView: true,
      userEvent: 'input.format',
      annotations: ownStep,
    }
  }
}

/** The caret at the end of `line`'s new prefix, after `spec` has run. */
function cursorAtEnd(state: EditorState, spec: TransactionSpec, line: Line): { selection: EditorSelection } {
  const tr = state.update(spec)
  const moved = tr.state.doc.lineAt(tr.changes.mapPos(line.from, -1))
  return { selection: EditorSelection.single(moved.from + linePrefix(moved.text).end) }
}

// ---------------------------------------------------------------------------
// List indent

interface ItemBlock {
  line: Line
  indent: string
  /** Lines below that belong to this item: deeper indent, no blank line in between. */
  children: Line[]
}

function itemBlock(state: EditorState, line: Line): ItemBlock {
  const indent = linePrefix(line.text).indent
  const children: Line[] = []
  for (let n = line.number + 1; n <= state.doc.lines; n += 1) {
    const next = state.doc.line(n)
    if (next.text.trim() === '') break
    const nextIndent = /^[ \t]*/.exec(next.text)![0]
    if (width(nextIndent) <= width(indent)) break
    children.push(next)
  }
  return { line, indent, children }
}

const width = (indent: string) => [...indent].reduce((sum, char) => sum + (char === '\t' ? 4 : 1), 0)

/** The item right above at the same depth, or null when this item opens its list. */
function previousSibling(state: EditorState, line: Line, indent: string): Line | null {
  for (let n = line.number - 1; n >= 1; n -= 1) {
    const above = state.doc.line(n)
    if (above.text.trim() === '') continue
    const prefix = linePrefix(above.text)
    const aboveWidth = width(/^[ \t]*/.exec(above.text)![0])
    if (aboveWidth > width(indent)) continue
    if (!LIST_KINDS.has(prefix.kind) || prefix.quote !== '') return null
    return aboveWidth === width(indent) ? above : null
  }
  return null
}

/** The item this one is nested under. */
function parentItem(state: EditorState, line: Line, indent: string): Line | null {
  for (let n = line.number - 1; n >= 1; n -= 1) {
    const above = state.doc.line(n)
    if (above.text.trim() === '') continue
    const aboveWidth = width(/^[ \t]*/.exec(above.text)![0])
    if (aboveWidth >= width(indent)) continue
    return LIST_KINDS.has(linePrefix(above.text).kind) ? above : null
  }
  return null
}

function listLines(state: EditorState): Line[] {
  return touchedLines(state)
    .map((n) => state.doc.line(n))
    .filter((line) => {
      const prefix = linePrefix(line.text)
      return LIST_KINDS.has(prefix.kind) && prefix.quote === '' && editableLine(state, line)
    })
}

/**
 * Tab and Shift-Tab on list items and to-dos. An item moves with its children. The
 * first item of a list cannot go deeper (nothing to nest under), a top-level item
 * cannot come out further. Not a list line: null, so Tab keeps moving focus.
 */
export function indentList(direction: 1 | -1): NoteTransform {
  return (state) => {
    const items = listLines(state)
    if (items.length === 0) return null
    const changes: ChangeSpec[] = []
    let coveredTo = -1
    for (const line of items) {
      if (line.number <= coveredTo) continue
      const block = itemBlock(state, line)
      coveredTo = block.children.at(-1)?.number ?? line.number
      let next: string | null = null
      if (direction === 1) {
        const sibling = previousSibling(state, line, block.indent)
        if (sibling === null) continue
        const siblingPrefix = linePrefix(sibling.text)
        const markerEnd = siblingPrefix.indent.length + /^(?:[-*+]|\d+[.)])[ \t]+/.exec(sibling.text.slice(siblingPrefix.indent.length))![0].length
        next = siblingPrefix.indent + ' '.repeat(markerEnd - siblingPrefix.indent.length)
      } else {
        if (block.indent === '') continue
        const parent = parentItem(state, line, block.indent)
        next = parent === null ? '' : linePrefix(parent.text).indent
      }
      for (const target of [block.line, ...block.children]) {
        if (!target.text.startsWith(block.indent)) continue
        changes.push({ from: target.from, to: target.from + block.indent.length, insert: next })
      }
    }
    // Inside a list, Tab never escapes the editor, even when this item cannot move.
    if (changes.length === 0) return { annotations: ownStep }
    const set = state.changes(changes)
    return withRenumber(state, { changes: set, selection: state.selection.map(set, 1), userEvent: 'input.indent', annotations: ownStep })
  }
}

// ---------------------------------------------------------------------------
// Typing rules

/**
 * Backspace with the caret right after a block mark removes the mark, so a heading,
 * list item, to-do or quote becomes plain text before anything joins. A nested item
 * comes out one level first. Null otherwise, so lang-markdown and the default run.
 */
export const unwrapBlockBackward: NoteTransform = (state) => {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  if (!editableLine(state, line)) return null
  const prefix = linePrefix(line.text)
  if (prefix.kind === 'text' || pos - line.from !== prefix.end || prefix.end === 0) return null
  if (LIST_KINDS.has(prefix.kind) && prefix.indent !== '' && prefix.quote === '') return indentList(-1)(state)
  let from: number
  if (prefix.marker === '') {
    // A quote: one level of `>` (with a callout token on it) goes at a time.
    from = line.from + prefix.indent.length + prefix.quote.lastIndexOf('>')
  } else {
    // Inside a quote only the inner mark goes; on its own the indent goes with it.
    from = prefix.quote === '' ? line.from : line.from + prefix.end - prefix.marker.length
  }
  return withRenumber(state, {
    changes: { from, to: line.from + prefix.end },
    userEvent: 'delete.backward',
    annotations: ownStep,
  })
}

/**
 * Enter on an empty quote line leaves the quote. lang-markdown waits for two empty
 * quote lines, which is right for CommonMark and wrong for how Notion feels.
 */
export const exitEmptyQuote: NoteTransform = (state) => {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  if (pos !== line.to || !/^[ \t]*>[ \t]*$/.test(line.text) || !editableLine(state, line)) return null
  // Only the quote's last line leaves it. In the middle, leaving would split the quote
  // (and cut a callout's tail off), so Enter adds another empty quote line instead.
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null
  if (next !== null && linePrefix(next.text).quote !== '') {
    const insert = `\n${line.text}`
    return { changes: { from: line.to, insert }, selection: EditorSelection.cursor(line.to + insert.length), scrollIntoView: true, userEvent: 'input', annotations: ownStep }
  }
  return { changes: { from: line.from, to: line.to }, selection: EditorSelection.cursor(line.from), userEvent: 'delete', annotations: ownStep }
}

/** `[]` then a space at the head of a line (or after a bullet) becomes a to-do. */
export function todoTrigger(state: EditorState, from: number, to: number, text: string): TransactionSpec | null {
  if (from !== to || state.selection.ranges.length !== 1 || !text.includes(' ') || text.includes('\n')) return null
  const line = state.doc.lineAt(from)
  const before = line.text.slice(0, from - line.from)
  // Fast typing delivers several characters at once (`[] first`), so the rule reads the
  // line as it will be. The space that completes `[]` must be one of the new characters.
  const typed = before + text
  const match = /^([ \t]*)(?:[-*+][ \t]+)?\[\] /.exec(typed)
  if (match === null || match[0].length <= before.length) return null
  if (inFrontmatter(state, from) || codeBlockAt(state, line) !== null) return null
  const insert = `${match[1]}- [ ] ${typed.slice(match[0].length)}`
  return {
    changes: { from: line.from, to: from, insert },
    selection: EditorSelection.cursor(line.from + insert.length),
    userEvent: 'input.type',
  }
}

// ---------------------------------------------------------------------------
// Moving and duplicating lines

function capture(command: StateCommand, state: EditorState): Transaction | null {
  let captured: Transaction | null = null
  command({ state, dispatch: (tr) => { captured = tr } })
  return captured
}

const LOCKED: ReadonlySet<string> = new Set(['Table'])

/**
 * Alt-ArrowUp and Alt-ArrowDown: the lines the selection touches move one line, and
 * numbered lists they leave or join renumber. A move into the frontmatter or into a
 * table is refused (consumed, so CodeMirror's plain line move does not run instead).
 */
export function moveLines(direction: 'up' | 'down'): NoteTransform {
  return (state) => {
    const numbers = touchedLines(state)
    const edge = direction === 'up' ? numbers[0]! - 1 : numbers[numbers.length - 1]! + 1
    if (edge < 1 || edge > state.doc.lines) return { annotations: ownStep }
    const neighbour = state.doc.line(edge)
    const moving = numbers.map((n) => state.doc.line(n))
    if ([neighbour, ...moving].some((line) => inFrontmatter(state, line.from))) return { annotations: ownStep }
    if (neighbour.length > 0 && enclosing(state, neighbour.from + 1, LOCKED) !== null) return { annotations: ownStep }
    const tr = capture(direction === 'up' ? moveLineUp : moveLineDown, state)
    if (tr === null) return { annotations: ownStep }
    return withRenumber(state, { changes: tr.changes, selection: tr.newSelection, scrollIntoView: true, userEvent: 'move.line', annotations: ownStep })
  }
}
