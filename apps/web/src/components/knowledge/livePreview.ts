import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { calloutTitle, calloutTone } from '../../vaultNotes'
import { caretAtoms, noteCaretExtensions, pendingItem } from './noteCaret'
import { noteEditingExtensions } from './noteEditing'
import { blockGap, frontmatterRange, inFrontmatter, wikilinksIn, type Wikilink } from './noteSyntax'
import { tablePreviewField, tablePreviewTheme } from './tablePreview'

/**
 * Obsidian's live preview, in the small.
 *
 * The text stays markdown, because the file on disk is markdown and anything that
 * edits a parsed tree instead has to answer what happens to the syntax it did not
 * understand. What changes is what you *see*: every heading, bold run and link is
 * styled as the thing it means, and the punctuation that says so is hidden, on the
 * caret's line too. List markers become a disc (or the number) and the item is
 * indented. Hidden ranges are atomic (`noteCaret.ts` steps over them), formatting
 * changes through the shortcuts, the toolbar and the link field, and only a fenced
 * code block shows its fences while the caret is inside it.
 */

/**
 * Each heading level: its size against the body, and the room above and below it in
 * its own em. Clearly more above than below, so a heading belongs to what follows.
 */
const HEADING_SCALE = [
  { size: '1.875em', above: '1em', below: '0.15em' },
  { size: '1.5em', above: '0.9em', below: '0.15em' },
  { size: '1.25em', above: '0.8em', below: '0.1em' },
  { size: '1.1em', above: '0.7em', below: '0.1em' },
  { size: '1em', above: '0.6em', below: '0.1em' },
  { size: '1em', above: '0.6em', below: '0.1em' },
]

/**
 * The syntax markers worth hiding: punctuation that exists only to say what the text
 * beside it is. List marks are not in this set: they become a disc (or the number)
 * and the item is indented, rather than leaving a dim `-` in the prose.
 */
const MARKER_NODES = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'CodeInfo', 'LinkMark', 'QuoteMark'])

/**
 * One indent step for a list item, and the width of the slot its marker hangs in.
 * Padding, never margin: the height map counts padding. Every marker (disc, number,
 * checkbox, and the source on the caret's line) ends `MARK_GAP_EM` before the text,
 * so the text of all three list kinds starts on one edge.
 */
const LIST_INDENT_EM = 1.5
const MARK_GAP_EM = 0.375

/** A heading line whose `#` run is followed by its space, so it is a heading being written. */
const HEADING_OPEN = /^ {0,3}#{1,6}[ \t]/

/** A quote's `>` markers (and the space after each) at the head of a line. */
const QUOTE_PREFIX = /^(?:[ \t]*>[ \t]?)*/

const hidden = Decoration.replace({})
const plainText = Decoration.mark({ class: 'cm-manor-plain' })
const fenceLine = Decoration.line({ class: 'cm-manor-codeblock-fence' })

const heading = HEADING_SCALE.map(({ size, above, below }) =>
  Decoration.line({ attributes: { class: 'cm-manor-heading', style: `font-size:${size};padding-top:${above};padding-bottom:${below}` } }),
)
const inlineCode = Decoration.mark({ class: 'cm-manor-inline-code' })
const taskDone = Decoration.mark({ class: 'cm-manor-task-done' })
const ruleLine = Decoration.line({ class: 'cm-manor-hr' })

const edgeLines = new Map<string, Decoration>()

/**
 * A line of a block that draws one surface across several lines (a code block, a
 * quote, a callout), told whether it opens or closes that surface so the corners
 * and the padding land on the outer lines only.
 */
function blockLine(base: string, index: number, count: number): Decoration {
  const edge = count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'mid'
  const key = `${base}:${edge}`
  let decoration = edgeLines.get(key)
  if (decoration === undefined) {
    decoration = Decoration.line({ class: `${base} ${base}-${edge}` })
    edgeLines.set(key, decoration)
  }
  return decoration
}

/** A divider as the thin line it means, where `---` was written. */
class RuleWidget extends WidgetType {
  eq() {
    return true
  }

  toDOM() {
    const rule = window.document.createElement('span')
    rule.className = 'cm-manor-hr-rule'
    rule.setAttribute('aria-hidden', 'true')
    return rule
  }

  ignoreEvent() {
    return false
  }
}

const rule = Decoration.replace({ widget: new RuleWidget() })

/** `[[target]]` and `[[target|label]]`, the vault's own link syntax. */
/** A task item's box, at the head of a list item. */
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s/

/** A callout's opening token, after the `>` markers the quote parser already ate. */
const CALLOUT = /^\s*(?:>\s?)*\[!([A-Za-z]+)\][-+]?[ \t]*/

/**
 * A real checkbox where `[ ]` was written. Clicking it rewrites that one character,
 * which makes the note dirty like any other edit and saves like any other edit; this
 * widget never writes to disk on its own.
 */
class TaskWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly at: number,
  ) {
    super()
  }

  eq(other: TaskWidget) {
    return other.checked === this.checked && other.at === this.at
  }

  toDOM(view: EditorView) {
    const slot = window.document.createElement('span')
    slot.className = 'cm-manor-taskslot'
    const box = window.document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-manor-task'
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ changes: { from: this.at, to: this.at + 1, insert: this.checked ? ' ' : 'x' } })
    })
    slot.append(box)
    return slot
  }

  ignoreEvent() {
    return false
  }
}

/** A disc in the list gutter. The markdown marker stays in the file. */
class BulletWidget extends WidgetType {
  eq() {
    return true
  }

  toDOM() {
    const mark = window.document.createElement('span')
    mark.className = 'cm-manor-bullet'
    mark.textContent = '•'
    mark.contentEditable = 'false'
    return mark
  }

  ignoreEvent() {
    return false
  }
}

/** The item number, sitting where the disc would on an unordered line. */
class NumberWidget extends WidgetType {
  constructor(private readonly mark: string) {
    super()
  }

  eq(other: NumberWidget) {
    return other.mark === this.mark
  }

  toDOM() {
    const el = window.document.createElement('span')
    el.className = 'cm-manor-olmark'
    el.textContent = this.mark
    el.contentEditable = 'false'
    return el
  }

  ignoreEvent() {
    return false
  }
}

const listLines: Decoration[] = []

function listLine(depth: number): Decoration {
  const capped = Math.min(Math.max(depth, 0), 8)
  const existing = listLines[capped]
  if (existing !== undefined) return existing
  const decoration = Decoration.line({
    attributes: {
      class: 'cm-manor-listitem',
      style: `padding-left:${(capped + 1) * LIST_INDENT_EM}em`,
    },
  })
  listLines[capped] = decoration
  return decoration
}

/** Nested `ListItem` ancestors, not counting the item that owns this mark. */
function listItemDepth(start: { parent: { name: string; parent: unknown } | null }): number {
  let depth = 0
  let parent: { name: string; parent: unknown } | null = start.parent
  while (parent !== null) {
    if (parent.name === 'ListItem') depth += 1
    parent = parent.parent as { name: string; parent: unknown } | null
  }
  return Math.max(0, depth - 1)
}

class LivePreview {
  decorations: DecorationSet
  /** The replaced ranges alone: what the caret steps over as one unit. */
  atoms: DecorationSet

  constructor(view: EditorView) {
    ;({ decorations: this.decorations, atoms: this.atoms } = build(view))
  }

  update(update: ViewUpdate) {
    // Selection counts: moving the caret into a code block is what shows its fences.
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) {
      ;({ decorations: this.decorations, atoms: this.atoms } = build(update.view))
    }
  }
}

function buildFrom(
  state: EditorState,
  visible: readonly { from: number; to: number }[],
  editing: Set<number>,
): { decorations: DecorationSet; atoms: DecorationSet } {
  // Collected rather than streamed into a RangeSetBuilder, because two passes produce
  // these and only one of them walks the document in order. `Decoration.set` sorts.
  const ranges: Range<Decoration>[] = []
  const atoms: Range<Decoration>[] = []
  const hide = (range: Range<Decoration>) => {
    ranges.push(range)
    atoms.push(range)
  }
  const meta = frontmatterRange(state)
  const links = wikilinkRanges(state, visible)
  // Fenced blocks seen so far. Their fence lines are settled as a whole below, so the
  // generic marker pass leaves the backticks and the language tag inside them alone.
  const fences: { from: number; to: number }[] = []

  for (const { from, to } of visible) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const line = state.doc.lineAt(node.from)
        const name = node.name

        // The table widget owns its inline rendering. Revealed tables keep source.
        if (name === 'Table') return false

        // The sealed frontmatter is the property list's; nothing in it is drawn here.
        if (meta !== null && node.to <= meta.to) return false
        // A heading needs its space: a bare `#` is still being typed, and stays text.
        if (name.startsWith('ATXHeading')) {
          const decoration = heading[Number(name.slice('ATXHeading'.length)) - 1]
          if (decoration !== undefined && HEADING_OPEN.test(line.text)) ranges.push(decoration.range(line.from))
          return
        }
        // A quote's bar belongs on every line it covers, not only its first. A callout
        // is the same node wearing a token, so both are settled here.
        if (name === 'Blockquote') {
          const opener = CALLOUT.exec(line.text)
          const numbers = lineRange(state, { from: node.from, to: node.to })
          numbers.forEach((number, index) => {
            const quoted = state.doc.line(number)
            ranges.push(blockLine(opener === null ? 'cm-manor-quote' : 'cm-manor-callout', index, numbers.length).range(quoted.from))
          })
          if (opener === null) return
          const type = opener[1] as string
          ranges.push(toneLine(type).range(line.from))
          // From just past the last `>` so this never overlaps the QuoteMark the walk
          // above already replaced; two replacements over one character is an error.
          // The space after it goes with the QuoteMark too.
          const marker = opener[0].lastIndexOf('>')
          const tokenFrom = line.from + marker + 1 + (/[ \t]/.test(opener[0].charAt(marker + 1)) ? 1 : 0)
          if (line.from + opener[0].length > tokenFrom) hide(hidden.range(tokenFrom, line.from + opener[0].length))
          if (line.text.slice(opener[0].length).trim() === '') {
            ranges.push(Decoration.widget({ widget: new LabelWidget(calloutTitle(type)) }).range(line.to))
          }
          return
        }
        // One surface for the whole fence. With the caret outside the block its fence
        // lines shrink to an even inset above and below the code, and the language
        // moves to a label in the corner; with the caret anywhere inside, both fences
        // come back so the block can be edited as text.
        if (name === 'FencedCode') {
          fences.push({ from: node.from, to: node.to })
          const numbers = lineRange(state, { from: node.from, to: node.to })
          numbers.forEach((number, index) => {
            ranges.push(blockLine('cm-manor-codeblock', index, numbers.length).range(state.doc.line(number).from))
          })
          if (numbers.some((number) => editing.has(number))) return
          const first = state.doc.line(numbers[0]!)
          const language = FENCE.exec(first.text)?.[1] ?? ''
          ranges.push(fenceLine.range(first.from))
          if (first.to > first.from) {
            hide((language === '' ? hidden : Decoration.replace({ widget: new CodeLanguageWidget(language) })).range(first.from, first.to))
          }
          const last = state.doc.line(numbers[numbers.length - 1]!)
          if (numbers.length > 1 && /^\s*(?:`{3,}|~{3,})\s*$/.test(last.text)) {
            ranges.push(fenceLine.range(last.from))
            if (last.to > last.from) hide(hidden.range(last.from, last.to))
          }
          return
        }
        if (name === 'InlineCode') {
          if (node.to > node.from) ranges.push(inlineCode.range(node.from, node.to))
          return
        }
        if ((name === 'CodeMark' || name === 'CodeInfo') && fences.some((fence) => node.from >= fence.from && node.to <= fence.to)) return
        if (name === 'HorizontalRule') {
          ranges.push(ruleLine.range(line.from))
          if (node.to > node.from) hide(rule.range(node.from, node.to))
          return
        }
        // Links read as their label and open on a click. Option-click puts the caret in
        // one, and the link field (⌘K, or the chip over a link) changes where it points.
        if (name === 'Link' || (name === 'URL' && node.node.parent?.name !== 'Link')) {
          const link = linkRange(state, node.node)
          if (link !== null) {
            ranges.push(Decoration.mark({ class: 'cm-manor-link', attributes: { 'data-href': link.href } }).range(link.from, link.to))
          }
          // The destination between `(` and `)` goes with the brackets, which the marker
          // pass below hides.
          if (name === 'Link') {
            const marks = node.node.getChildren('LinkMark')
            if (marks.length >= 4 && marks[3]!.from > marks[2]!.to) hide(hidden.range(marks[2]!.to, marks[3]!.from))
          }
          return
        }
        // The marker hangs in the indent's slot, so the item text starts on the same
        // edge whatever the marker is and whether or not the caret is on the line.
        // A task's marker runs through its box, which the checkbox replaces.
        // A bare mark without its space is still being typed, and stays text until the
        // space turns it into the block.
        if (name === 'ListMark') {
          const task = TASK.exec(line.text)
          const space = node.to < line.to && /[ \t]/.test(state.doc.sliceString(node.to, node.to + 1)) ? 1 : 0
          if (task === null && space === 0) return
          ranges.push(listLine(listItemDepth(node.node)).range(line.from))
          const start = line.from + (QUOTE_PREFIX.exec(line.text)?.[0].length ?? 0)
          const end = task === null ? node.to + space : line.from + task[0].length
          const mark = state.doc.sliceString(node.from, node.to)
          const widget = task !== null
            ? new TaskWidget((task[2] as string).toLowerCase() === 'x', line.from + (task[1] as string).length + 1)
            : /^\d+[.)]$/.test(mark) ? new NumberWidget(mark) : new BulletWidget()
          hide(Decoration.replace({ widget }).range(start, end))
          return
        }
        if (!MARKER_NODES.has(name)) return
        // A setext underline stays as written; hiding it would hide a line being typed.
        if (name === 'HeaderMark' && node.node.parent?.name.startsWith('SetextHeading') === true) return
        if (name === 'HeaderMark' && node.from === line.from + (line.text.length - line.text.trimStart().length) && !HEADING_OPEN.test(line.text)) return
        // A wikilink's brackets are handled below as one unit; letting the built-in
        // link parser hide half of them is what turned `[[a|b]]` into `[a|b]`.
        if (links.some((link) => node.from >= link.from && node.to <= link.to)) return
        // A heading's `#` and a quote's `>` take the space after them too, or the text
        // starts indented by a space.
        const spaced = (name === 'HeaderMark' || name === 'QuoteMark') && /[ \t]/.test(state.doc.sliceString(node.to, node.to + 1))
        const end = spaced ? Math.min(node.to + 1, line.to) : node.to
        if (end > node.from) hide(hidden.range(node.from, end))
      },
    })
  }

  // `- ` typed under a paragraph is a list item from its space on, before the parse agrees.
  for (const number of visibleLines(state, visible)) {
    const line = state.doc.line(number)
    const start = pendingItem(state, line)
    if (start === null) continue
    const mark = line.text.trim()
    ranges.push(listLine(0).range(line.from))
    hide(Decoration.replace({ widget: /^\d/.test(mark) ? new NumberWidget(mark) : new BulletWidget() }).range(start, line.to))
    // Read as a heading underline, the `-` would make the paragraph above a heading.
    const heading = syntaxTree(state).resolveInner(start, 1).parent
    if (heading?.name.startsWith('SetextHeading') === true && line.from - 1 > heading.from) ranges.push(plainText.range(heading.from, line.from - 1))
  }

  // A done item stays readable but steps back, on every line including the caret's.
  // The parser sees an ordinary list item; what makes it a task is the token at the
  // head of the line, so this reads lines rather than nodes.
  for (const number of visibleLines(state, visible)) {
    const line = state.doc.line(number)
    const task = TASK.exec(line.text)
    if (task === null || (task[2] as string).toLowerCase() !== 'x') continue
    if (line.from + task[0].length < line.to) ranges.push(taskDone.range(line.from + task[0].length, line.to))
  }

  for (const link of links) {
    if (meta !== null && link.from <= meta.to) continue
    // `[[`, and everything up to and including the `|`, disappear; the label is what
    // a reader wants and the target is what the file needs.
    hide(hidden.range(link.from, link.labelFrom))
    ranges.push(Decoration.mark({ class: 'cm-manor-wikilink', attributes: {
      role: 'link', tabindex: '0', 'data-note-target': link.target,
      title: 'Open note. Option-click to edit the link.',
    } }).range(link.labelFrom, link.labelTo))
    hide(hidden.range(link.labelTo, link.to))
  }

  return { decorations: Decoration.set(ranges, true), atoms: Decoration.set(atoms, true) }
}

/**
 * Decorations for the whole document. Tests inspect widgets without mounting a view.
 * The live plugin still builds only the visible range.
 */
export function livePreviewDecorationSet(state: EditorState, editingLines: readonly number[] = []): DecorationSet {
  return buildFrom(state, [{ from: 0, to: state.doc.length }], new Set(editingLines)).decorations
}

/** The ranges the caret steps over as one unit, for the whole document. Tests read these. */
export function livePreviewAtoms(state: EditorState, editingLines: readonly number[] = []): DecorationSet {
  return buildFrom(state, [{ from: 0, to: state.doc.length }], new Set(editingLines)).atoms
}

function build(view: EditorView) {
  return buildFrom(view.state, view.visibleRanges, activeLines(view))
}

/** A markdown link's visible text and where it points, or a bare URL as both. */
function linkRange(state: EditorState, node: { name: string; from: number; to: number; getChildren: (name: string) => { from: number; to: number }[]; getChild: (name: string) => { from: number; to: number } | null }): { from: number; to: number; href: string } | null {
  if (node.name === 'URL') {
    const href = state.doc.sliceString(node.from, node.to)
    return node.to > node.from ? { from: node.from, to: node.to, href } : null
  }
  const marks = node.getChildren('LinkMark')
  const url = node.getChild('URL')
  if (marks.length < 2 || url === null) return null
  const raw = state.doc.sliceString(url.from, url.to)
  const href = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
  const from = marks[0]!.to
  const to = marks[1]!.from
  return to > from ? { from, to, href } : null
}

/** Every `[[link]]` in view, with the slice of it a reader should actually see. */
function wikilinkRanges(state: EditorState, visible: readonly { from: number; to: number }[]): Wikilink[] {
  return visible.flatMap(({ from, to }) => wikilinksIn(state.doc.sliceString(from, to), from))
}

/** A word the document does not contain, for a callout that named no title. */
class LabelWidget extends WidgetType {
  constructor(private readonly label: string) {
    super()
  }

  eq(other: LabelWidget) {
    return other.label === this.label
  }

  toDOM() {
    const span = window.document.createElement('span')
    span.textContent = this.label
    return span
  }
}

/** A code block's language, as a quiet label in its corner while the fences are hidden. */
class CodeLanguageWidget extends WidgetType {
  constructor(private readonly language: string) {
    super()
  }

  eq(other: CodeLanguageWidget) {
    return other.language === this.language
  }

  toDOM() {
    const span = window.document.createElement('span')
    span.className = 'cm-manor-code-lang'
    span.textContent = this.language
    span.setAttribute('aria-hidden', 'true')
    return span
  }
}

/** An opening or closing fence: its marker and the language tag after it. */
const FENCE = /^\s*(?:`{3,}|~{3,})\s*([^\s`~]*)/

const toneLines = new Map<string, Decoration>()

/** One line decoration per callout type, cached so identical lines share one object. */
function toneLine(type: string): Decoration {
  const tone = calloutTone(type)
  let decoration = toneLines.get(tone)
  if (decoration === undefined) {
    decoration = Decoration.line({ class: `cm-manor-callout-title cm-manor-callout-${tone}` })
    toneLines.set(tone, decoration)
  }
  return decoration
}

/** Every line number currently on screen. */
function visibleLines(
  state: EditorState,
  visible: readonly { from: number; to: number }[],
): number[] {
  const numbers: number[] = []
  for (const { from, to } of visible) {
    const first = state.doc.lineAt(from).number
    const last = state.doc.lineAt(to).number
    for (let n = first; n <= last; n += 1) numbers.push(n)
  }
  return numbers
}

/** The line numbers a range covers, inclusive. */
function lineRange(state: EditorState, range: { from: number; to: number }): number[] {
  const first = state.doc.lineAt(range.from).number
  const last = state.doc.lineAt(range.to).number
  const numbers: number[] = []
  for (let n = first; n <= last; n += 1) numbers.push(n)
  return numbers
}

/** Every line any cursor or selection touches; a code block there shows its fences. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>()
  if (!view.hasFocus) return lines
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number
    const last = view.state.doc.lineAt(range.to).number
    for (let line = first; line <= last; line += 1) lines.add(line)
  }
  return lines
}

/**
 * The document's one spacing scale, in pixels at the editor's 16px body: the line
 * (1.6, which a blank line in the markdown already is), and the block gap, which is
 * one such line. A heading keeps its own room in `HEADING_SCALE`.
 */
const BODY_PX = 16
const BLOCK_GAP_PX = BODY_PX * 1.6
/** A divider's line, with the rule centred in it; its half counts toward the gap. */
const RULE_LINE_PX = 12

/** Empty room between two blocks, as a block widget so it sits outside both surfaces. */
class GapWidget extends WidgetType {
  constructor(private readonly height: number) {
    super()
  }

  eq(other: GapWidget) {
    return other.height === this.height
  }

  get estimatedHeight() {
    return this.height
  }

  toDOM() {
    const gap = window.document.createElement('div')
    gap.className = 'cm-manor-gap'
    gap.style.height = `${this.height}px`
    gap.setAttribute('aria-hidden', 'true')
    return gap
  }
}

const gapWidgets = new Map<number, Decoration>()

function gap(height: number, side: -1 | 1): Decoration {
  const key = height * side
  let decoration = gapWidgets.get(key)
  if (decoration === undefined) {
    decoration = Decoration.widget({ widget: new GapWidget(height), block: true, side })
    gapWidgets.set(key, decoration)
  }
  return decoration
}

/**
 * Room around quotes, callouts, code blocks, dividers and tables where the markdown
 * puts them straight against their neighbour. A block widget, so a state field, and
 * read from the state alone: the caret never changes it.
 */
function gapDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const tree = syntaxTree(state)
  for (let node = tree.topNode.firstChild; node !== null; node = node.nextSibling) {
    if (!['Blockquote', 'FencedCode', 'CodeBlock', 'HorizontalRule', 'Table'].includes(node.name)) continue
    if (node.name === 'HorizontalRule' && inFrontmatter(state, node.from)) continue
    const first = state.doc.lineAt(node.from)
    const last = state.doc.lineAt(node.to)
    const room = blockGap(state, first.number, last.number)
    const inset = node.name === 'HorizontalRule' ? RULE_LINE_PX / 2 : 0
    if (room.above !== null) ranges.push(gap((room.above === 'full' ? BLOCK_GAP_PX : BLOCK_GAP_PX / 2) - inset, -1).range(first.from))
    if (room.below) ranges.push(gap(BLOCK_GAP_PX - inset, 1).range(last.to))
  }
  return Decoration.set(ranges, true)
}

const gapField = StateField.define<DecorationSet>({
  create: gapDecorations,
  update: (value, transaction) =>
    transaction.docChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state) ? gapDecorations(transaction.state) : value,
  provide: (field) => EditorView.decorations.from(field),
})

const livePreviewPlugin = ViewPlugin.fromClass(LivePreview, {
  decorations: (plugin) => plugin.decorations,
  provide: (plugin) => [
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atoms ?? Decoration.none),
    caretAtoms.of((view) => view.plugin(plugin)?.atoms ?? Decoration.none),
  ],
})

/**
 * What each kind of run looks like once its markers are gone. Colours come from the
 * theme tokens rather than a palette of their own, so the editor follows light and
 * dark with the rest of the app.
 */
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text)' },
  { tag: tags.strong, fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--color-muted)' },
  { tag: tags.link, color: 'var(--accent-fg)', textDecoration: 'underline', textUnderlineOffset: '2px' },
  { tag: tags.url, color: 'var(--color-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontVariantLigatures: 'none', color: 'var(--color-text)' },
  { tag: tags.contentSeparator, color: 'var(--color-muted)' },
])

/** Prose geometry. The editor is a page, not a code pane: no gutter, no line numbers. */
const theme = EditorView.theme({
  '&': { color: 'var(--color-text)', backgroundColor: 'transparent', fontSize: '16px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    // A wide block must not contribute its intrinsic width to this flex item.
    minWidth: '0',
    width: '100%',
    fontFamily: 'var(--font-sans)',
    lineHeight: '1.6',
    padding: '0',
    caretColor: 'var(--color-text)',
  },
  // Prose keeps its reading measure; block tables may use the whole note pane.
  '.cm-line': { padding: '0', maxWidth: '46rem', marginLeft: 'auto', marginRight: 'auto' },
  // Padding, never margin. CodeMirror's height map is built from each line's
  // offsetHeight, which counts padding and ignores margin; a margined line therefore
  // measures short, the map drifts, and every click below it lands further down the
  // document than the pointer did. That was the misplaced-caret bug.
  // Weight 500, not bold: the house has two weights (docs/DESIGN.md), so a heading
  // earns its rank from size and the room around it.
  '.cm-manor-plain, .cm-manor-plain *': { fontWeight: '400' },
  '.cm-manor-heading': { lineHeight: '1.3', fontWeight: 'var(--font-weight-medium)', letterSpacing: '-0.01em' },
  // The list marker's slot: as wide as one indent step, hung into it, the marker set
  // against the slot's right so its gap to the text is the same for every kind.
  '.cm-manor-bullet, .cm-manor-olmark, .cm-manor-taskslot': {
    display: 'inline-block',
    boxSizing: 'border-box',
    width: `${LIST_INDENT_EM}em`,
    marginLeft: `-${LIST_INDENT_EM}em`,
    paddingRight: `${MARK_GAP_EM}em`,
    textAlign: 'right',
    whiteSpace: 'pre',
    pointerEvents: 'none',
  },
  '.cm-manor-olmark': { color: 'var(--color-muted)', fontVariantNumeric: 'tabular-nums' },
  // A quote is a solid bar in the text colour, upright; a callout is a soft surface
  // the note raises for itself. Both pad only their outer lines, so a long one reads
  // as one block with the same rhythm as a code block.
  '.cm-manor-quote': { borderLeft: '3px solid var(--color-text)', paddingLeft: '0.9em' },
  '.cm-manor-quote-first, .cm-manor-quote-only': { paddingTop: '0.15em' },
  '.cm-manor-quote-last, .cm-manor-quote-only': { paddingBottom: '0.15em' },
  '.cm-manor-callout': { backgroundColor: 'var(--color-surface-2)', paddingLeft: '0.9em', paddingRight: '0.9em' },
  '.cm-manor-callout-first, .cm-manor-callout-only': {
    paddingTop: '0.5em',
    borderTopLeftRadius: 'var(--radius-lg)',
    borderTopRightRadius: 'var(--radius-lg)',
  },
  '.cm-manor-callout-last, .cm-manor-callout-only': {
    paddingBottom: '0.5em',
    borderBottomLeftRadius: 'var(--radius-lg)',
    borderBottomRightRadius: 'var(--radius-lg)',
  },
  '.cm-manor-codeblock': {
    backgroundColor: 'var(--color-surface-2)',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'none',
    fontSize: '0.875em',
    lineHeight: '1.6',
    paddingLeft: '1.15em',
    paddingRight: '1.15em',
  },
  '.cm-manor-codeblock-first, .cm-manor-codeblock-only': {
    borderTopLeftRadius: 'var(--radius-lg)',
    borderTopRightRadius: 'var(--radius-lg)',
  },
  '.cm-manor-codeblock-last, .cm-manor-codeblock-only': {
    borderBottomLeftRadius: 'var(--radius-lg)',
    borderBottomRightRadius: 'var(--radius-lg)',
  },
  // A hidden fence is the block's inset: the same small height above and below.
  '.cm-manor-codeblock-fence': { position: 'relative', boxSizing: 'border-box', height: '8px', fontSize: '8px', lineHeight: '8px' },
  '.cm-manor-code-lang': {
    position: 'absolute',
    top: '6px',
    right: '12px',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    lineHeight: '16px',
    color: 'var(--color-dim)',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  '.cm-manor-inline-code': {
    backgroundColor: 'var(--color-surface-2)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.1em 0.3em',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'none',
    fontSize: '0.875em',
  },
  // One fixed height whether it shows the rule or its `---`, so the caret never jolts it.
  '.cm-manor-hr': { boxSizing: 'border-box', height: `${RULE_LINE_PX}px`, fontSize: `${RULE_LINE_PX}px`, lineHeight: `${RULE_LINE_PX}px`, color: 'var(--color-muted)' },
  '.cm-manor-hr-rule': {
    display: 'inline-block',
    width: '100%',
    height: '1px',
    // Pinned to the line's top and pushed to its exact middle: \`middle\` would follow
    // the x-height and sit a pixel off.
    verticalAlign: 'top',
    marginTop: `${(RULE_LINE_PX - 1) / 2}px`,
    backgroundColor: 'var(--color-line)',
  },
  // An autolink or bare URL is a link too: the accent, never the muted URL colour.
  '.cm-manor-link': { color: 'var(--accent-fg)', textDecoration: 'underline', textUnderlineOffset: '2px' },
  '.cm-manor-link *': { color: 'inherit' },
  '.cm-manor-link[data-href]': { cursor: 'pointer' },
  // A rounded square that fills with the accent when done. Drawn here rather than
  // left to the platform, which renders a different box on every OS.
  // \`middle\` sets the box's centre on the x-height's, whatever the line's size.
  '.cm-manor-task': {
    appearance: 'none',
    display: 'inline-grid',
    placeContent: 'center',
    boxSizing: 'border-box',
    width: '1em',
    height: '1em',
    margin: '0',
    verticalAlign: 'middle',
    border: '1.5px solid var(--color-muted)',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    pointerEvents: 'auto',
  },
  '.cm-manor-task:checked': { backgroundColor: 'var(--accent)', borderColor: 'var(--accent)' },
  '.cm-manor-task:checked::after': {
    content: '""',
    boxSizing: 'border-box',
    width: '0.3em',
    height: '0.55em',
    marginTop: '-0.1em',
    border: 'solid var(--color-on-primary)',
    borderWidth: '0 2px 2px 0',
    transform: 'rotate(45deg)',
  },
  '.cm-manor-task:focus-visible': { outline: '2px solid var(--accent-fg)', outlineOffset: '2px' },
  '.cm-manor-task-done': { color: 'var(--color-muted)', textDecoration: 'line-through' },
  '.cm-manor-callout-title': { fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text)' },
  '.cm-manor-callout-good': { color: 'var(--color-ok)' },
  '.cm-manor-callout-warn': { color: 'var(--color-warn)' },
  '.cm-manor-callout-bad': { color: 'var(--color-danger)' },
  '.cm-manor-wikilink': { color: 'var(--accent-fg)', textDecoration: 'underline', cursor: 'pointer', textUnderlineOffset: '2px' },
  '.cm-manor-wikilink:focus-visible': { outline: '2px solid var(--color-text)', outlineOffset: '2px', borderRadius: '2px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-user-bg)',
  },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
})

/** Everything the note editor turns on, in one list. */
export const livePreviewExtensions = (): Extension[] => [
  // lang-markdown's own Enter and Backspace are replaced by `noteEditingExtensions`.
  markdown({ base: markdownLanguage, addKeymap: false }),
  noteEditingExtensions(),
  noteCaretExtensions(),
  syntaxHighlighting(highlight),
  gapField,
  tablePreviewField,
  tablePreviewTheme,
  livePreviewPlugin,
  theme,
  EditorView.lineWrapping,
]
