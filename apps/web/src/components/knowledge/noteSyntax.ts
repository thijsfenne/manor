import { isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { ChangeSet, EditorState, Line, StateCommand, TransactionSpec } from '@codemirror/state'

/**
 * The shared reading of a note's markdown for the formatting commands. Every command
 * is a pure transformation: an `EditorState` in, a transaction spec out (or null when
 * it does not apply), so the tests run on a state without a DOM.
 */
export type NoteTransform = (state: EditorState) => TransactionSpec | null

/** A transform as a CodeMirror command. Null means "not mine", so the next binding runs. */
export const asCommand = (transform: NoteTransform): StateCommand => ({ state, dispatch }) => {
  const spec = transform(state)
  if (spec === null) return false
  dispatch(state.update(spec))
  return true
}

/** One undo step per command, never merged into the typing around it. */
export const ownStep = isolateHistory.of('full')

/** `[[target]]` or `[[target|label]]`, on one line. */
const WIKILINK = /\[\[([^[\]\n]+?)\]\]/g

/** A wikilink: its whole span, its target, and the label a reader sees. */
export interface Wikilink {
  from: number
  to: number
  target: string
  labelFrom: number
  labelTo: number
}

/** Every wikilink with a visible label in `text`, which starts at `offset` in the document. */
export function wikilinksIn(text: string, offset: number): Wikilink[] {
  const found: Wikilink[] = []
  for (const match of text.matchAll(WIKILINK)) {
    const inner = match[1] as string
    const pipe = inner.indexOf('|')
    const from = offset + match.index
    const labelFrom = from + 2 + (pipe === -1 ? 0 : pipe + 1)
    const labelTo = from + 2 + inner.length
    if (labelTo > labelFrom) found.push({ from, to: from + match[0].length, target: (pipe === -1 ? inner : inner.slice(0, pipe)).trim(), labelFrom, labelTo })
  }
  return found
}

type Tree = ReturnType<typeof syntaxTree>
export type SyntaxNode = ReturnType<Tree['resolveInner']>

/**
 * The tree parsed at least to `upto` (a little past the place being asked about),
 * or the partial tree when that would block typing in a very long note.
 */
export function noteTree(state: EditorState, upto: number = state.doc.length): Tree {
  return ensureSyntaxTree(state, Math.min(state.doc.length, upto), 50) ?? syntaxTree(state)
}

/** How far past a position the parse must reach to answer questions about it. */
const AHEAD = 2_000

/** The block a line is, as the Turn into menu names it. */
export type BlockKind = 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'todo' | 'quote' | 'code'

export const LIST_KINDS: ReadonlySet<BlockKind> = new Set(['bullet', 'number', 'todo'])

/** The markup at the head of one line, split into the parts a command rewrites. */
export interface LinePrefix {
  indent: string
  /** `> ` markers, including a callout's `[!type]` token on its first line. */
  quote: string
  /** The innermost block mark: `## `, `- `, `3. `, `- [ ] `. Empty for text and quotes. */
  marker: string
  kind: BlockKind
  /** Offset in the line where the text itself starts. */
  end: number
  number?: number
  delimiter?: string
  checked?: boolean
}

const LEAD = /^([ \t]*)((?:>[ \t]?)*)/
const CALLOUT = /^\[![A-Za-z]+\][-+]?[ \t]*/
const HEADING = /^(#{1,6})(?:[ \t]+|$)/
const BULLET = /^([-*+])[ \t]+(?:\[([ xX])\](?:[ \t]+|$))?/
const ORDERED = /^(\d{1,9})([.)])[ \t]+(?:\[([ xX])\](?:[ \t]+|$))?/
const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/

/**
 * The head of a line read as markdown. A line prefix is the one place a regular
 * expression is the honest tool: the tree has no node for "the bytes before the text",
 * and the commands that use this check the tree first for code and frontmatter.
 */
export function linePrefix(text: string): LinePrefix {
  const lead = LEAD.exec(text) as RegExpExecArray
  const indent = lead[1] as string
  let quote = lead[2] as string
  let at = lead[0].length
  if (quote !== '') {
    const callout = CALLOUT.exec(text.slice(at))
    if (callout !== null) {
      quote += callout[0]
      at += callout[0].length
    }
  }
  const rest = text.slice(at)
  if (RULE.test(rest)) return { indent, quote, marker: '', kind: quote === '' ? 'text' : 'quote', end: at }
  const heading = HEADING.exec(rest)
  if (heading !== null) {
    const level = (heading[1] as string).length
    const kind = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
    return { indent, quote, marker: heading[0], kind, end: at + heading[0].length }
  }
  const bullet = BULLET.exec(rest)
  if (bullet !== null) {
    const box = bullet[2]
    return {
      indent, quote, marker: bullet[0], kind: box === undefined ? 'bullet' : 'todo', end: at + bullet[0].length,
      ...(box === undefined ? {} : { checked: box.toLowerCase() === 'x' }),
    }
  }
  const ordered = ORDERED.exec(rest)
  if (ordered !== null) {
    const box = ordered[3]
    return {
      indent, quote, marker: ordered[0], kind: box === undefined ? 'number' : 'todo', end: at + ordered[0].length,
      number: Number(ordered[1]), delimiter: ordered[2] as string,
      ...(box === undefined ? {} : { checked: box.toLowerCase() === 'x' }),
    }
  }
  return { indent, quote, marker: '', kind: quote === '' ? 'text' : 'quote', end: at }
}

/** A thematic break, which looks like a list to the prefix reader and is not one. */
export const isRule = (text: string) => RULE.test(text)

/** The leading `---` block, when the note opens with one. Same rule as the live preview. */
export function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const doc = state.doc
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return null
  for (let n = 2; n <= doc.lines; n += 1) {
    const line = doc.line(n)
    const text = line.text.trimEnd()
    if (text === '---' || text === '...') return { from: doc.line(1).from, to: line.to }
  }
  return null
}

export function inFrontmatter(state: EditorState, pos: number): boolean {
  const meta = frontmatterRange(state)
  return meta !== null && pos >= meta.from && pos <= meta.to
}

/** The nearest ancestor of `pos` (either side) whose name is in `names`. */
export function enclosing(state: EditorState, pos: number, names: ReadonlySet<string>): SyntaxNode | null {
  const tree = noteTree(state, pos + AHEAD)
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node !== null; node = node.parent) {
      if (names.has(node.name)) return node
    }
  }
  return null
}

const CODE_BLOCKS: ReadonlySet<string> = new Set(['FencedCode', 'CodeBlock'])

/** The fenced or indented code block a line sits in, fences included. */
export function codeBlockAt(state: EditorState, line: Line): SyntaxNode | null {
  const tree = noteTree(state, line.to + AHEAD)
  for (let node: SyntaxNode | null = tree.resolveInner(line.from, 1); node !== null; node = node.parent) {
    if (CODE_BLOCKS.has(node.name)) return node
  }
  if (line.length === 0) return null
  for (let node: SyntaxNode | null = tree.resolveInner(line.to, -1); node !== null; node = node.parent) {
    if (CODE_BLOCKS.has(node.name)) return node
  }
  return null
}

const TABLES: ReadonlySet<string> = new Set(['Table'])

export function inTable(state: EditorState, line: Line): boolean {
  return line.length > 0 && enclosing(state, line.from + Math.min(1, line.length), TABLES) !== null
}

/** The block a line is, for the Turn into label. */
export function blockKindAt(state: EditorState, pos: number): BlockKind {
  const line = state.doc.lineAt(pos)
  if (codeBlockAt(state, line) !== null) return 'code'
  return linePrefix(line.text).kind
}

/** Every line number any selection range touches, once, in order. */
export function touchedLines(state: EditorState): number[] {
  const numbers = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    let last = state.doc.lineAt(range.to).number
    // A drag that ends at the very start of a line has not selected anything on it.
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last -= 1
    for (let n = first; n <= last; n += 1) numbers.add(n)
  }
  return [...numbers].sort((a, b) => a - b)
}

/**
 * Two steps as one transaction: `first` on `state`, then whatever `next` makes of
 * the state that produced. The second step's changes are composed onto the first,
 * so undo takes both back at once.
 */
export function chain(
  state: EditorState,
  first: TransactionSpec,
  next: (after: EditorState, changes: ChangeSet) => TransactionSpec | null,
): TransactionSpec {
  const step = state.update(first)
  const more = next(step.state, step.changes)
  if (more === null) return { ...first, changes: step.changes, selection: step.newSelection }
  const second = step.state.update(more)
  return {
    changes: step.changes.compose(second.changes),
    selection: second.newSelection,
    scrollIntoView: true,
    ...(first.userEvent === undefined ? {} : { userEvent: first.userEvent }),
    ...(first.effects === undefined ? {} : { effects: first.effects }),
    annotations: ownStep,
  }
}

// ---------------------------------------------------------------------------
// The live preview's block rhythm

/** Blocks that draw their own surface or rule, and so stand apart from the prose around them. */
const SPACED_BLOCKS: ReadonlySet<string> = new Set(['Blockquote', 'FencedCode', 'CodeBlock', 'HorizontalRule', 'Table'])

type LineKind = 'blank' | 'heading' | 'spaced' | 'prose'

/** What the top-level block holding line `number` is, for spacing purposes. */
function lineKind(state: EditorState, number: number): LineKind {
  const line = state.doc.line(number)
  if (line.text.trim() === '') return 'blank'
  let node: SyntaxNode | null = syntaxTree(state).resolve(line.from, 1)
  while (node !== null && node.parent !== null && node.parent.name !== 'Document') node = node.parent
  if (node === null || node.name === 'Document') return 'prose'
  if (/^(ATX|Setext)Heading/.test(node.name)) return 'heading'
  if (SPACED_BLOCKS.has(node.name) && !(node.name === 'HorizontalRule' && inFrontmatter(state, node.from))) return 'spaced'
  return 'prose'
}

export interface BlockGap {
  /** Room above the block: a full gap, a half gap under a heading, or none. */
  above: 'full' | 'half' | null
  /** Room below the block. */
  below: boolean
}

/**
 * The gap a spaced block (quote, callout, code, divider, table) on lines `first` to
 * `last` adds itself. A blank line in the markdown is already one line of room, so the
 * block adds nothing on that side; a neighbour written straight against it gets the
 * same room from the block instead. Between two spaced blocks only the lower one adds
 * it, so the gap never doubles. A heading keeps its own small room below, so a block
 * right under one takes a half gap.
 */
export function blockGap(state: EditorState, first: number, last: number): BlockGap {
  const before = first > 1 ? lineKind(state, first - 1) : 'blank'
  const after = last < state.doc.lines ? lineKind(state, last + 1) : 'blank'
  const atTop = first === 1 || (frontmatterRange(state)?.to ?? -1) >= state.doc.line(first - 1).from
  return {
    above: atTop || before === 'blank' ? null : before === 'heading' ? 'half' : 'full',
    below: after === 'prose' || after === 'heading',
  }
}
