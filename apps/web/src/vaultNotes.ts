/**
 * What a vault note is, on top of what markdown already is: YAML frontmatter at the
 * head, `[[wikilinks]]` in the prose, and a filename that is usually the only title.
 * Pure functions, so the whole vocabulary can be exercised without a DOM. Which note
 * a link points at is shared with the phone, in `@manor/client-runtime/vault-notes`.
 */
import { readWikilink } from '@manor/client-runtime/vault-notes'

/** The four frontmatter fields worth showing. Everything else stays out of the render. */
export interface NoteFrontmatter {
  tags: string[]
  type: string | null
  status: string | null
  date: string | null
}

export interface ParsedNote {
  /** Absent when the note has no frontmatter block; 7 of the user's 370 are like that. */
  frontmatter: NoteFrontmatter | null
  /**
   * What the header calls this note. The body's own opening H1 when it has one,
   * because `# Jane Example` beats `jane`; the filename otherwise. Either way
   * the breadcrumb above it still names the real file, so the two never disagree
   * about which note is open.
   */
  title: string
  /**
   * What the renderer sees: no frontmatter, and no opening H1 when that H1 became
   * the title. Two titles stacked is the defect this avoids.
   */
  body: string
}

const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/
const FIELD = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/
const LIST_ITEM = /^[ \t]*-[ \t]+(.*)$/
const HEADING_1 = /^#[ \t]+(.+?)[ \t]*$/

/** Everything a note view needs, in one pass over the file the server handed back. */
export function parseNote(path: string, text: string): ParsedNote {
  const { fields, body } = splitFrontmatter(text)
  const opening = takeOpeningHeading(body)
  return {
    frontmatter: fields === null ? null : readFields(fields),
    title: opening?.title ?? fileTitle(path),
    body: opening?.rest ?? body,
  }
}

/** The note's name with its extension off, which is also what the tree shows. */
export const fileTitle = (path: string): string => (path.split('/').at(-1) ?? path).replace(/\.md$/i, '')

/** The folders above a note, for the breadcrumb. Empty at the vault root. */
export const noteFolder = (path: string): string => path.split('/').slice(0, -1).join('/')

/**
 * Splits the leading `---` block off, without a YAML parser. Four scalar fields and
 * a tag list is the whole surface here, and a real parser would be a dependency
 * whose extra 95% is never read.
 */
function splitFrontmatter(text: string): { fields: string[] | null; body: string } {
  if (!FRONTMATTER_OPEN.test(text)) return { fields: null, body: text }
  const lines = text.split(/\r?\n/)
  const end = lines.findIndex((line, index) => index > 0 && FRONTMATTER_CLOSE.test(line))
  // An unterminated block is not frontmatter, it is a note that opens with a rule.
  if (end === -1) return { fields: null, body: text }
  return { fields: lines.slice(1, end), body: lines.slice(end + 1).join('\n').replace(/^\r?\n/, '') }
}

/** One frontmatter key with everything under it, however it was written. */
export interface NoteProperty {
  key: string
  values: string[]
}

/**
 * Every frontmatter key, in the order the file wrote them. This is what a properties
 * panel shows; `readFields` is the same data narrowed to the four the chips use.
 */
export function readProperties(lines: string[]): NoteProperty[] {
  const properties: NoteProperty[] = []
  for (const [index, line] of lines.entries()) {
    const field = FIELD.exec(line)
    if (field === null) continue
    const value = scalar(field[2] ?? '')
    // Three shapes are all in this vault: a bare scalar, `[a, b]` on one line, and a
    // block list on the lines below.
    const values =
      value === '' ? blockList(lines, index) : value.startsWith('[') ? inlineList(value) : [value]
    properties.push({ key: field[1] as string, values })
  }
  return properties
}

/**
 * Where the prose starts, as a character offset. The editor opens its caret here
 * rather than at zero: a note is opened to write in, and landing inside the
 * frontmatter would greet every ⌘E with raw YAML instead of the properties panel.
 */
export function bodyOffset(text: string): number {
  if (!FRONTMATTER_OPEN.test(text)) return 0
  const lines = text.split(/\r?\n/)
  let offset = 0
  for (const [index, line] of lines.entries()) {
    offset += line.length + 1
    if (index > 0 && FRONTMATTER_CLOSE.test(line)) return Math.min(offset, text.length)
  }
  return 0
}

function readFields(lines: string[]): NoteFrontmatter {
  const front: NoteFrontmatter = { tags: [], type: null, status: null, date: null }
  const only = (values: string[]) => values[0] ?? null
  for (const property of readProperties(lines)) {
    if (property.key === 'tags') front.tags = property.values
    else if (property.key === 'type') front.type = only(property.values)
    else if (property.key === 'status') front.status = only(property.values)
    else if (property.key === 'date') front.date = only(property.values)
  }
  return front
}

/** The `- item` lines directly under a key, stopping at the next key. */
function blockList(lines: string[], from: number): string[] {
  const items: string[] = []
  for (const line of lines.slice(from + 1)) {
    const item = LIST_ITEM.exec(line)
    if (item === null) break
    const value = scalar(item[1] ?? '')
    if (value !== '') items.push(value)
  }
  return items
}

const inlineList = (value: string): string[] =>
  value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(scalar)
    .filter((entry) => entry !== '')

const scalar = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '').trim()

/** The opening `# Title`, and what is left once it has been lifted out. */
function takeOpeningHeading(body: string): { title: string; rest: string } | null {
  const lines = body.split(/\r?\n/)
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first === -1) return null
  const heading = HEADING_1.exec(lines[first] ?? '')
  if (heading === null) return null
  return { title: heading[1] as string, rest: lines.slice(first + 1).join('\n').replace(/^\r?\n/, '') }
}

// ---------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------

/**
 * Obsidian's callouts: a blockquote whose first line is `[!type] Optional title`.
 * The type is an open vocabulary of about twenty words that all mean one of four
 * things, so they are read down to a tone here rather than carried around as strings.
 */
export type CalloutTone = 'neutral' | 'good' | 'warn' | 'bad'

const TONES: Record<string, CalloutTone> = {
  tip: 'good',
  hint: 'good',
  important: 'good',
  success: 'good',
  check: 'good',
  done: 'good',
  warning: 'warn',
  caution: 'warn',
  attention: 'warn',
  question: 'warn',
  help: 'warn',
  faq: 'warn',
  failure: 'bad',
  fail: 'bad',
  missing: 'bad',
  danger: 'bad',
  error: 'bad',
  bug: 'bad',
}

/** Anything unrecognised is a plain block, never a red one. */
export const calloutTone = (type: string): CalloutTone => TONES[type.toLowerCase()] ?? 'neutral'

/** The word above a callout when its author did not write one. */
export const calloutTitle = (type: string): string => type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()

const CALLOUT = /^\[!([A-Za-z]+)\][-+]?[ \t]*/

/**
 * Turns those blockquotes into something the renderer can style as a block, and
 * leaves every other blockquote alone. The type and the title travel as attributes
 * rather than as text, so the title row can carry an icon the markdown never had.
 */
export function remarkCallouts() {
  return () => (tree: MdNode) => markCallouts(tree)
}

function markCallouts(node: MdNode) {
  for (const child of node.children ?? []) {
    if (child.type === 'blockquote') applyCallout(child)
    markCallouts(child)
  }
}

function applyCallout(quote: MdNode) {
  const first = quote.children?.[0]
  if (first === undefined || first.type !== 'paragraph') return
  const opener = first.children?.[0]
  if (opener === undefined || opener.type !== 'text' || opener.value === undefined) return
  const match = CALLOUT.exec(opener.value)
  if (match === null) return

  const type = match[1] as string
  opener.value = opener.value.slice(match[0].length)

  // Markdown folds every line of a quote into one paragraph, so the title and the
  // callout's first sentence arrive as one node with a newline between them. Without
  // this split, `[!warning] Let op` followed by a sentence renders as one long title.
  const body = splitFirstLine(first)
  if (body !== null) quote.children?.splice(1, 0, body)
  // `[!tip]` on its own line: the type becomes the title, which is what Obsidian
  // shows too, rather than a titleless bar nobody can name.
  if (plainText(first).trim() === '') first.children = [{ type: 'text', value: calloutTitle(type) }]

  const attributes = { className: ['manor-callout-title'], 'data-callout': type }
  first.data = { ...first.data, hProperties: attributes }
  quote.data = {
    ...quote.data,
    hName: 'div',
    hProperties: { className: ['manor-callout'], 'data-callout': type },
  }
}

/**
 * Cuts a paragraph at its first line break and returns what came after as a new
 * paragraph, or null when it was a single line already.
 */
function splitFirstLine(paragraph: MdNode): MdNode | null {
  const children = paragraph.children ?? []
  const at = children.findIndex((child) => child.type === 'text' && (child.value ?? '').includes('\n'))
  if (at === -1) return null
  const node = children[at] as MdNode
  const value = node.value ?? ''
  const cut = value.indexOf('\n')
  const tail = value.slice(cut + 1)
  node.value = value.slice(0, cut)
  const rest: MdNode[] = [...(tail === '' ? [] : [{ type: 'text', value: tail }]), ...children.slice(at + 1)]
  paragraph.children = children.slice(0, at + 1)
  return rest.length === 0 ? null : { type: 'paragraph', children: rest }
}

/** Everything a node says, ignoring how it says it. */
function plainText(node: MdNode): string {
  if (node.value !== undefined) return node.value
  return (node.children ?? []).map(plainText).join('')
}

// ---------------------------------------------------------------------------
// Wikilinks
// ---------------------------------------------------------------------------

/**
 * A resolved `[[link]]`, as an href the markdown sanitiser leaves alone. A fragment
 * carries no scheme, so react-markdown's default url transform passes it through
 * untouched and no note can smuggle a `javascript:` past it by looking internal.
 */
export const NOTE_HREF = '#manor-note/'

/** A `[[link]]` that points at no note in this vault. Rendered dead, never clickable. */
export const MISSING_HREF = '#manor-missing'

/** The note path behind a rendered link, or null when the href is an ordinary one. */
export function noteTarget(href: string | undefined): string | null {
  if (href === undefined || !href.startsWith(NOTE_HREF)) return null
  try {
    return decodeURIComponent(href.slice(NOTE_HREF.length))
  } catch {
    return null
  }
}

export const isMissingNote = (href: string | undefined): boolean => href === MISSING_HREF

/** The minimum of an mdast node this walk touches. Everything else rides along. */
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  /** Where mdast carries instructions for the HTML it becomes. */
  data?: Record<string, unknown>
}

const WIKILINK = /\[\[([^[\]\n]+?)\]\]/g

/**
 * Turns `[[note]]` and `[[note|label]]` into links, resolved against the vault's own
 * path list. Written here rather than pulled in because the whole job is one regex
 * over text nodes: the plugins on offer bring a syntax extension and a config
 * surface for a syntax that has exactly one form.
 */
export function remarkWikilinks(resolve: (target: string) => string | null) {
  return () => (tree: MdNode) => walk(tree, resolve)
}

function walk(node: MdNode, resolve: (target: string) => string | null) {
  const children = node.children
  if (children === undefined) return
  const next: MdNode[] = []
  let changed = false
  for (const child of children) {
    if (child.type === 'text' && child.value !== undefined && child.value.includes('[[')) {
      const expanded = expand(child.value, resolve)
      if (expanded !== null) {
        next.push(...expanded)
        changed = true
        continue
      }
    }
    // Code keeps its brackets, and a wikilink inside a real link has nowhere to go.
    if (child.type !== 'code' && child.type !== 'inlineCode' && child.type !== 'link') walk(child, resolve)
    next.push(child)
  }
  if (changed) node.children = next
}

function expand(value: string, resolve: (target: string) => string | null): MdNode[] | null {
  const nodes: MdNode[] = []
  let cursor = 0
  WIKILINK.lastIndex = 0
  for (let match = WIKILINK.exec(value); match !== null; match = WIKILINK.exec(value)) {
    const link = readWikilink(match[1] as string)
    if (link === null) continue
    const { target, label } = link
    if (match.index > cursor) nodes.push({ type: 'text', value: value.slice(cursor, match.index) })
    const path = resolve(target)
    nodes.push({
      type: 'link',
      url: path === null ? MISSING_HREF : NOTE_HREF + encodeURIComponent(path),
      children: [{ type: 'text', value: label }],
    })
    cursor = match.index + match[0].length
  }
  if (nodes.length === 0) return null
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes
}
