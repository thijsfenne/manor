import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange } from '@codemirror/state'
import { codeBlockAt, inFrontmatter, inTable, linePrefix, noteTree, ownStep, wikilinksIn, type NoteTransform, type SyntaxNode, type Wikilink } from './noteSyntax'

/**
 * Inline formatting for the note editor: bold, italic, strikethrough, inline code and
 * links, each a toggle written as markdown. Whether a range already carries a mark is
 * read from the syntax tree, never guessed from asterisks on the line.
 */
export type InlineMark = 'bold' | 'italic' | 'strike' | 'code'

const MARKS: Record<InlineMark, { node: string; mark: string; token: string }> = {
  bold: { node: 'StrongEmphasis', mark: 'EmphasisMark', token: '**' },
  italic: { node: 'Emphasis', mark: 'EmphasisMark', token: '*' },
  strike: { node: 'Strikethrough', mark: 'StrikethroughMark', token: '~~' },
  code: { node: 'InlineCode', mark: 'CodeMark', token: '`' },
}

export const INLINE_MARKS = Object.keys(MARKS) as InlineMark[]

interface Segment {
  from: number
  to: number
}

interface MarkNode {
  from: number
  to: number
  /** The text between the opening and closing marks. */
  contentFrom: number
  contentTo: number
  open: string
  close: string
}

function markNode(state: EditorState, node: SyntaxNode, mark: InlineMark): MarkNode | null {
  const first = node.firstChild
  const last = node.lastChild
  const name = MARKS[mark].mark
  if (first === null || last === null || first.name !== name || last.name !== name || first.from === last.from) return null
  return {
    from: node.from,
    to: node.to,
    contentFrom: first.to,
    contentTo: last.from,
    open: state.doc.sliceString(first.from, first.to),
    close: state.doc.sliceString(last.from, last.to),
  }
}

/** The run of `mark` that holds all of `[from, to]`, markers counted as inside it. */
function coveringNode(state: EditorState, from: number, to: number, mark: InlineMark): MarkNode | null {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = noteTree(state).resolveInner(from, side); node !== null; node = node.parent) {
      if (node.name !== MARKS[mark].node || node.from > from || node.to < to) continue
      const found = markNode(state, node, mark)
      if (found !== null) return found
    }
  }
  return null
}

/** Every run of `mark` that overlaps `[from, to]`. */
function overlappingNodes(state: EditorState, from: number, to: number, mark: InlineMark): MarkNode[] {
  const found: MarkNode[] = []
  noteTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== MARKS[mark].node || node.to <= from || node.from >= to) return
      const run = markNode(state, node.node, mark)
      if (run !== null) found.push(run)
    },
  })
  return found
}

/**
 * The parts of a range that inline marks may wrap: one per line, past the line's
 * block mark, without the spaces at either end. Marks do not cross lines in
 * markdown, so a multi-line selection is formatted line by line.
 */
function segments(state: EditorState, from: number, to: number): Segment[] | null {
  const found: Segment[] = []
  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n += 1) {
    const line = state.doc.line(n)
    if (inFrontmatter(state, line.from) || codeBlockAt(state, line) !== null) return null
    if (inTable(state, line)) continue
    let start = Math.max(from, line.from + linePrefix(line.text).end)
    let end = Math.min(to, line.to)
    while (start < end && /\s/.test(state.doc.sliceString(start, start + 1))) start += 1
    while (end > start && /\s/.test(state.doc.sliceString(end - 1, end))) end -= 1
    if (end > start) found.push({ from: start, to: end })
  }
  return found
}

// ---------------------------------------------------------------------------
// Atomic ranges: inline code, links, bare URLs and wikilinks. Their text is not
// formatted prose (a link target, an alias, code), so a mark never lands inside one
// except where the rules below allow it.

type AtomKind = 'code' | 'link' | 'url' | 'wikilink'

interface Atom {
  from: number
  to: number
  kind: AtomKind
  /** For a link: the label, the one part of it that takes inline marks. */
  labelFrom: number
  labelTo: number
}

function atomsOn(state: EditorState, from: number, to: number): Atom[] {
  const first = state.doc.lineAt(from)
  const last = state.doc.lineAt(to)
  const atoms: Atom[] = []
  noteTree(state, last.to + 2_000).iterate({
    from: first.from,
    to: last.to,
    enter: (node) => {
      if (node.name === 'InlineCode') {
        atoms.push({ from: node.from, to: node.to, kind: 'code', labelFrom: node.from, labelTo: node.from })
        return false
      }
      if (node.name === 'Link') {
        const marks = node.node.getChildren('LinkMark')
        const labelled = marks.length >= 2
        atoms.push({ from: node.from, to: node.to, kind: 'link', labelFrom: labelled ? marks[0]!.to : node.from, labelTo: labelled ? marks[1]!.from : node.from })
        return undefined
      }
      if (node.name === 'Image' || node.name === 'Autolink' || node.name === 'URL') {
        atoms.push({ from: node.from, to: node.to, kind: 'url', labelFrom: node.from, labelTo: node.from })
        return false
      }
      return undefined
    },
  })
  // The same `[[...]]` reading as the live preview.
  for (const link of wikilinksIn(state.doc.sliceString(first.from, last.to), first.from)) {
    atoms.push({ from: link.from, to: link.to, kind: 'wikilink', labelFrom: link.from, labelTo: link.from })
  }
  return atoms
}

/**
 * Whether `mark` (or a new link) may go on `[from, to]` given the atomic ranges there.
 * A range that partly overlaps one is refused; one that wholly holds it wraps it
 * from outside (a link never wraps another link). Inside inline code only the code
 * toggle works, inside a link only the label takes marks, inside a URL or a
 * wikilink nothing does. An empty range is a caret: refused strictly inside.
 */
function atomsAllow(state: EditorState, from: number, to: number, mark: InlineMark | 'link'): boolean {
  for (const atom of atomsOn(state, from, to)) {
    const touches = from === to ? atom.from < from && from < atom.to : atom.from < to && atom.to > from
    if (!touches) continue
    if (from < to && from <= atom.from && atom.to <= to) {
      if (mark === 'link' && atom.kind !== 'code') return false
      continue
    }
    if (atom.from <= from && to <= atom.to) {
      if (atom.kind === 'code' && mark === 'code' && from < to) continue
      if (atom.kind === 'link' && mark !== 'link' && atom.labelFrom <= from && to <= atom.labelTo) continue
    }
    return false
  }
  return true
}

/** Nodes that change how the lines after them read: a fence, a rule. */
const BLOCK_BREAKERS: ReadonlySet<string> = new Set(['FencedCode', 'CodeBlock', 'HorizontalRule', 'SetextHeading1', 'SetextHeading2'])
const INLINE_HOSTS = /^(Paragraph|ATXHeading\d|SetextHeading\d|TableCell)$/

/** How many fences and rules start at or after `from`; the text before a change cannot gain one. */
function blockBreakers(state: EditorState, from: number): number {
  let count = 0
  noteTree(state).iterate({
    from,
    enter: (node) => {
      if (node.to < from) return false
      if (BLOCK_BREAKERS.has(node.name)) count += 1
      if (INLINE_HOSTS.test(node.name)) return false
      return undefined
    },
  })
  return count
}

/**
 * A mark's characters can fuse with the same character next to them (`~` beside
 * `~~` opens a tilde fence, a stray backtick swallows the pair). Rather than predict
 * every such case from the text, the result is read back: the marked ranges must
 * parse as marked and no fence or rule may appear. Otherwise the command declines.
 */
function parsesAsIntended(state: EditorState, changes: ChangeSpec[], marked: Segment[], mark: InlineMark | null): boolean {
  const set = state.changes(changes)
  const after = state.update({ changes: set }).state
  let from = state.doc.length
  set.iterChangedRanges((fromA) => { from = Math.min(from, fromA) })
  const start = state.doc.lineAt(from).from
  if (blockBreakers(after, start) !== blockBreakers(state, start)) return false
  if (mark === null) return true
  return marked.every((part) => {
    const from = set.mapPos(part.from, 1)
    const to = set.mapPos(part.to, -1)
    return to <= from || coveringNode(after, from, to, mark) !== null
  })
}

/** `~a~` (read as a single-tilde mark) holding `[from, to]`, upgraded rather than wrapped again. */
function singleTildeAround(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = noteTree(state).resolveInner(from, side); node !== null; node = node.parent) {
      if (node.name !== 'Subscript' || node.from > from || node.to < to) continue
      if (state.doc.sliceString(node.from, node.from + 1) !== '~' || state.doc.sliceString(node.to - 1, node.to) !== '~') return null
      return { from: node.from, to: node.to }
    }
  }
  return null
}

/** Whether every part of the main selection already carries `mark`. */
export function markActive(state: EditorState, mark: InlineMark): boolean {
  const range = state.selection.main
  if (range.empty) return coveringNode(state, range.head, range.head, mark) !== null
  const parts = segments(state, range.from, range.to)
  return parts !== null && parts.length > 0 && parts.every((part) => coveringNode(state, part.from, part.to, mark) !== null)
}

/** Wrap a segment in `mark`, folding any run of it inside or overlapping into one. */
function applyChanges(state: EditorState, part: Segment, mark: InlineMark): ChangeSpec[] {
  const token = MARKS[mark].token
  let from = part.from
  let to = part.to
  const changes: ChangeSpec[] = []
  let openAt: ChangeSpec | null = null
  let closeAt: ChangeSpec | null = null
  for (const run of overlappingNodes(state, part.from, part.to, mark)) {
    if (run.from < from) {
      from = run.from
      openAt = { from: run.from, to: run.contentFrom, insert: token }
    } else changes.push({ from: run.from, to: run.contentFrom })
    if (run.to > to) {
      to = run.to
      closeAt = { from: run.contentTo, to: run.to, insert: token }
    } else changes.push({ from: run.contentTo, to: run.to })
  }
  changes.push(openAt ?? { from, insert: token })
  changes.push(closeAt ?? { from: to, insert: token })
  return changes
}

/**
 * Take `mark` off a segment inside one run of it. The parts of the run outside the
 * segment keep their mark, so unbolding a word in a bold sentence splits the run.
 */
function removeChanges(state: EditorState, part: Segment, run: MarkNode): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  let left = Math.max(part.from, run.contentFrom)
  while (left > run.contentFrom && /\s/.test(state.doc.sliceString(left - 1, left))) left -= 1
  let right = Math.min(part.to, run.contentTo)
  while (right < run.contentTo && /\s/.test(state.doc.sliceString(right, right + 1))) right += 1
  if (left <= run.contentFrom) changes.push({ from: run.from, to: run.contentFrom })
  else changes.push({ from: left, insert: run.close })
  if (right >= run.contentTo) changes.push({ from: run.contentTo, to: run.to })
  else changes.push({ from: right, insert: run.open })
  return changes
}

/**
 * Mod-b, Mod-i, Mod-Shift-s, Mod-e and the toolbar's toggles. A selection that
 * already has the mark everywhere loses it, otherwise it gains it. With a bare
 * caret the word under it is toggled; with no word, an empty pair is inserted with
 * the caret inside. Every range is handled; code and frontmatter are declined.
 */
export function toggleMark(mark: InlineMark): NoteTransform {
  return (state) => {
    const token = MARKS[mark].token
    let declined = false
    const spec = state.changeByRange((range) => {
      const result = toggleRange(state, range, mark, token)
      if (result === null) {
        declined = true
        return { range }
      }
      return result
    })
    if (declined) return null
    return { ...spec, scrollIntoView: true, userEvent: 'input.format', annotations: ownStep }
  }
}

function toggleRange(state: EditorState, range: SelectionRange, mark: InlineMark, token: string): { changes: ChangeSpec[]; range: SelectionRange } | null {
  if (range.empty) {
    const pos = range.head
    const line = state.doc.lineAt(pos)
    if (inFrontmatter(state, pos) || codeBlockAt(state, line) !== null) return null
    const word = state.wordAt(pos)
    if (word === null) {
      if (!atomsAllow(state, pos, pos, mark)) return null
      // An empty pair parses as nothing, so it is read off the text: a second press
      // right after the first takes it away again.
      const size = token.length
      const char = token[0]!
      if (
        state.sliceDoc(pos - size, pos) === token && state.sliceDoc(pos, pos + size) === token &&
        state.sliceDoc(pos - size - 1, pos - size) !== char && state.sliceDoc(pos + size, pos + size + 1) !== char
      ) {
        return { changes: [{ from: pos - size, to: pos + size }], range: EditorSelection.cursor(pos - size) }
      }
      const changes = [{ from: pos, insert: token + token }]
      if (!parsesAsIntended(state, changes, [], null)) return null
      return { changes, range: EditorSelection.cursor(pos + token.length) }
    }
    const result = toggleParts(state, [word], mark)
    if (result === null) return null
    const set = state.changes(result)
    return { changes: result, range: EditorSelection.cursor(set.mapPos(pos, pos === word.from ? 1 : -1)) }
  }
  const parts = segments(state, range.from, range.to)
  if (parts === null) return null
  if (parts.length === 0) return { changes: [], range }
  const changes = toggleParts(state, parts, mark)
  if (changes === null) return null
  const set = state.changes(changes)
  const anchor = set.mapPos(range.anchor, range.anchor <= range.head ? 1 : -1)
  const head = set.mapPos(range.head, range.head < range.anchor ? 1 : -1)
  return { changes, range: EditorSelection.range(anchor, head) }
}

/**
 * The changes that toggle `mark` on every part, or null when any part may not take
 * it (an atomic range in the way) or the result would not read back as intended.
 */
function toggleParts(state: EditorState, parts: Segment[], mark: InlineMark): ChangeSpec[] | null {
  if (parts.some((part) => !atomsAllow(state, part.from, part.to, mark))) return null
  const runs = parts.map((part) => coveringNode(state, part.from, part.to, mark))
  if (runs.every((run) => run !== null)) {
    const changes = parts.flatMap((part, index) => removeChanges(state, part, runs[index]!))
    return parsesAsIntended(state, changes, [], null) ? changes : null
  }
  const changes = parts.flatMap((part) => {
    // `~a~` already reads as struck through on GitHub; it becomes `~~a~~`, never `~~~a~~~`.
    const single = mark === 'strike' ? singleTildeAround(state, part.from, part.to) : null
    return single === null ? applyChanges(state, part, mark) : [{ from: single.from, insert: '~' }, { from: single.to, insert: '~' }]
  })
  return parsesAsIntended(state, changes, parts, mark) ? changes : null
}

/** Whether toggling `mark` on the main selection would do something, for the toolbar. */
export function markAvailable(state: EditorState, mark: InlineMark): boolean {
  return toggleMark(mark)(state) !== null
}

/** Which marks the main selection has, for the toolbar's pressed states. */
export function activeMarks(state: EditorState): Record<InlineMark, boolean> {
  return {
    bold: markActive(state, 'bold'),
    italic: markActive(state, 'italic'),
    strike: markActive(state, 'strike'),
    code: markActive(state, 'code'),
  }
}

// ---------------------------------------------------------------------------
// Links

export interface LinkInfo {
  from: number
  to: number
  textFrom: number
  textTo: number
  url: string
  urlFrom: number
  urlTo: number
}

/** The inline `[text](url)` link holding `[from, to]`. Reference links are not edited here. */
export function linkAt(state: EditorState, from: number, to: number = from): LinkInfo | null {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = noteTree(state).resolveInner(from, side); node !== null; node = node.parent) {
      if (node.name !== 'Link' || node.from > from || node.to < to) continue
      const marks = node.getChildren('LinkMark')
      const url = node.getChild('URL')
      if (marks.length < 4 || url === null) return null
      const raw = state.doc.sliceString(url.from, url.to)
      return {
        from: node.from,
        to: node.to,
        textFrom: marks[0]!.to,
        textTo: marks[1]!.from,
        url: raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw,
        urlFrom: url.from,
        urlTo: url.to,
      }
    }
  }
  return null
}

/**
 * What the user typed, as a markdown link target. A bare domain gets `https://` so it
 * does not resolve as a note path; spaces and brackets get the `<...>` form markdown
 * has for them.
 */
export function formatUrl(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || /^[/#.]/.test(trimmed) || !/^[\w-]+(\.[\w-]+)+(?:[/?#:]|$)/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  return /[\s<>()]/.test(withScheme) ? `<${withScheme.replace(/[<>]/g, '')}>` : withScheme
}

/** Where a clicked link in a note goes. */
export type LinkDestination = { kind: 'website' | 'mail'; url: string } | { kind: 'note'; target: string } | { kind: 'refused' }

/**
 * A link's destination: http(s) and a bare `www.` address are websites, `mailto:`
 * and a bare address are mail, a value without a scheme is a note in the vault.
 * Every other scheme (javascript:, file:, data:, an app's own) is refused.
 */
export function linkDestination(href: string): LinkDestination {
  const value = href.trim()
  if (/^www\.[^\s/]+\.[^\s]+$/i.test(value)) return { kind: 'website', url: `https://${value}` }
  if (/^[^\s@/:]+@[^\s@/]+\.[a-z]{2,}$/i.test(value) && !/\.md$/i.test(value)) return { kind: 'mail', url: `mailto:${value}` }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)
  if (scheme === null) return { kind: 'note', target: value }
  const name = scheme[1]!.toLowerCase()
  if (name !== 'http' && name !== 'https' && name !== 'mailto') return { kind: 'refused' }
  try {
    const url = new URL(value)
    return { kind: url.protocol === 'mailto:' ? 'mail' : 'website', url: url.href }
  } catch {
    return { kind: 'refused' }
  }
}

/** The main selection, or the word at the caret, as the text a new link wraps. */
export function linkTarget(state: EditorState): { from: number; to: number } | null {
  const range = state.selection.main
  if (!range.empty) return { from: range.from, to: range.to }
  return state.wordAt(range.head)
}

/**
 * Apply `url` to the main selection: retarget the link it is in, wrap the selected
 * text (or the word at the caret), or insert `[url](url)` where there is neither.
 * An empty url removes the link. Several selections, or one across lines, decline.
 */
export function setLink(url: string): NoteTransform {
  return (state) => {
    if (state.selection.ranges.length !== 1) return null
    const range = state.selection.main
    if (url.trim() === '') return removeLink(state)
    const target = formatUrl(url)
    const existing = linkAt(state, range.from, range.to)
    if (existing !== null && !atomsOn(state, range.from, range.to).some((atom) => atom.kind === 'wikilink' && atom.from < range.to && atom.to > range.from)) {
      return { changes: { from: existing.urlFrom, to: existing.urlTo, insert: target }, userEvent: 'input.format', annotations: ownStep }
    }
    const wrap = linkTarget(state)
    if (wrap === null) {
      if (inFrontmatter(state, range.head) || codeBlockAt(state, state.doc.lineAt(range.head)) !== null) return null
      if (!atomsAllow(state, range.head, range.head, 'link')) return null
      const insert = `[${url.trim()}](${target})`
      return { changes: { from: range.head, insert }, selection: EditorSelection.cursor(range.head + insert.length), userEvent: 'input.format', annotations: ownStep }
    }
    if (state.doc.lineAt(wrap.from).number !== state.doc.lineAt(wrap.to).number) return null
    const parts = segments(state, wrap.from, wrap.to)
    if (parts === null || parts.length !== 1) return null
    const part = parts[0]!
    if (!atomsAllow(state, part.from, part.to, 'link')) return null
    const changes = [{ from: part.from, insert: '[' }, { from: part.to, insert: `](${target})` }]
    return {
      changes,
      selection: EditorSelection.range(part.from + 1, part.to + 1),
      scrollIntoView: true,
      userEvent: 'input.format',
      annotations: ownStep,
    }
  }
}

/** The link around the main selection back to its plain text. */
export const removeLink: NoteTransform = (state) => {
  const range = state.selection.main
  const link = linkAt(state, range.from, range.to)
  if (link === null) return null
  const text = state.doc.sliceString(link.textFrom, link.textTo)
  return {
    changes: { from: link.from, to: link.to, insert: text },
    selection: EditorSelection.range(link.from, link.from + text.length),
    userEvent: 'input.format',
    annotations: ownStep,
  }
}

/** A link label as the reader sees it: `\[` and `\]` without their backslash. */
export const linkLabelText = (raw: string): string => raw.replace(/\\([[\]])/g, '$1')

/** The wikilink whose span holds `pos` (either edge counts), or null. */
export function wikilinkAt(state: EditorState, pos: number): Wikilink | null {
  const line = state.doc.lineAt(pos)
  return wikilinksIn(line.text, line.from).find((link) => pos >= link.from && pos <= link.to) ?? null
}

/**
 * The link at the caret given new text and a new destination, as the link field
 * edits it: a markdown link rewrites only its text or its url, so a title or an
 * escape it already has stays; a wikilink writes `[[target]]` or `[[target|text]]`.
 * An empty destination unlinks, leaving the text.
 */
export function editLinkAt(pos: number, text: string, destination: string): NoteTransform {
  return (state) => {
    const wiki = wikilinkAt(state, pos)
    const link = wiki === null ? linkAt(state, pos) : null
    const span = wiki === null ? link : { ...wiki, textFrom: wiki.labelFrom, textTo: wiki.labelTo }
    if (span === null) return null
    const current = linkLabelText(state.doc.sliceString(span.textFrom, span.textTo))
    const shown = text.trim() === '' ? current : text.trim()
    const target = destination.trim()
    const changes: { from: number; to: number; insert: string }[] = []
    if (target === '') changes.push({ from: span.from, to: span.to, insert: shown })
    else if (wiki !== null) {
      const insert = shown === target ? `[[${target}]]` : `[[${target}|${shown.replace(/[[\]|]/g, '')}]]`
      if (insert !== state.doc.sliceString(wiki.from, wiki.to)) changes.push({ from: wiki.from, to: wiki.to, insert })
    }
    else if (link !== null) {
      if (shown !== current) changes.push({ from: link.textFrom, to: link.textTo, insert: shown.replace(/([[\]])/g, '\\$1') })
      // An untouched destination stays as written; formatting it could turn `docs.md` into a website.
      if (target !== link.url && target !== state.doc.sliceString(link.urlFrom, link.urlTo)) changes.push({ from: link.urlFrom, to: link.urlTo, insert: formatUrl(target) })
    }
    if (changes.length === 0) return null
    const set = state.changes(changes)
    return {
      changes: set,
      selection: EditorSelection.cursor(set.mapPos(span.to, 1)),
      userEvent: 'input.format',
      annotations: ownStep,
    }
  }
}
