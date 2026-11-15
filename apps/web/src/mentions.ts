import { imageRefSpans, parseMentions, mentionSpans, quoteRefSpans, type AgentConfig, type InlineQuote, type SkillConfig } from '@manor/contracts'
import { agentMentionSpans } from '@manor/client-runtime/mentions'

export { parseMentions, mentionSpans }
// Shared with the native client; the routing and completion readers live in the
// client runtime, so the phone's composer and the Mac's answer the same rules.
export {
  addressDraft,
  chatFallbackTargets,
  composerShowsRecipients,
  draftRecipients,
  eligibleSkills,
  activeImageRef,
  activeMention,
  activeSkill,
  applyImageRef,
  applyMention,
  applySkill,
  insertTrigger,
  matchAgents,
  matchesBrowserMention,
  matchesWorkMention,
  matchFiles,
  matchImageRefs,
  matchSkills,
  replyFallbackTargets,
  roomAgents,
} from '@manor/client-runtime/mentions'

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'agent'; text: string; agent: AgentConfig }
  | { kind: 'browser'; text: string }
  | { kind: 'computer'; text: string }
  | { kind: 'work'; text: string }
  | { kind: 'file'; text: string; path: string }
  | { kind: 'skill'; text: string; skill: SkillConfig }
  | { kind: 'image'; text: string; number: number }
  | { kind: 'quote'; text: string; number: number; quote: InlineQuote }

/**
 * A `$` or path-shaped `@` token, from a word boundary to the next space.
 * Persona mentions do not come from this; those are `mentionSpans`.
 */
const TOKEN = /(?<![\p{L}\p{N}_-])([@$])(\S+)/gu
const TRAILING = /[.,;:!?)\]}'"]+$/

/**
 * Splits a message into what should be tinted and what should not. One tokenizer for
 * both surfaces: the composer paints backgrounds behind these ranges and the bubble
 * renders them as chips, and two rules would mean a mention that highlights while
 * typing and goes plain once sent.
 *
 * Personas come from `mentionSpans`, the same scan the server routes on, so a chip
 * and a turn cannot disagree. A token holding a '/' is a file, clipped so a persona
 * the scanner still finds inside it (`@Manor/foo,@Sage`) keeps its own chip. Path
 * shape decides rather than the repo listing, so a mention keeps its meaning after
 * the file is renamed, after the folder is unlinked, and in a chat whose listing
 * never loaded. Unknown handles stay plain text, which is exactly what the server
 * does with them.
 */
export function mentionSegments(
  text: string,
  agents: readonly AgentConfig[],
  skills: readonly SkillConfig[] = [],
  /** The draft's or message's own pictures; `[Image #n]` past the last is prose. */
  imageCount = 0,
  /** The draft's or message's own quotes; `[Quote #n]` past the last is prose. */
  quotes: readonly InlineQuote[] = [],
): MentionSegment[] {
  const byName = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent]))
  const bySkillId = new Map(skills.map((skill) => [skill.id, skill]))

  type Mark = { start: number; end: number; segment: Exclude<MentionSegment, { kind: 'text' }> }
  const marks: Mark[] = imageRefSpans(text, imageCount).map((span) => ({
    start: span.start,
    end: span.end,
    segment: { kind: 'image', text: text.slice(span.start, span.end), number: span.number },
  }))
  for (const span of quoteRefSpans(text, quotes.length)) {
    marks.push({ start: span.start, end: span.end, segment: { kind: 'quote', text: text.slice(span.start, span.end), number: span.number, quote: quotes[span.number - 1]! } })
  }

  for (const span of mentionSpans(text)) {
    const kind = span.handle.toLowerCase()
    if (kind !== 'browser' && kind !== 'computer' && kind !== 'work') continue
    const end = span.start + 1 + span.handle.length
    marks.push({ start: span.start, end, segment: { kind, text: text.slice(span.start, end) } })
  }

  for (const span of agentMentionSpans(text, agents)) {
    const agent = byName.get(span.handle.toLowerCase())
    if (agent === undefined) continue
    const end = span.start + 1 + span.handle.length
    if (marks.some((mark) => span.start < mark.end && end > mark.start)) continue
    marks.push({
      start: span.start,
      end,
      segment: { kind: 'agent', text: text.slice(span.start, end), agent },
    })
  }

  const overlaps = (start: number, end: number) =>
    marks.some((mark) => start < mark.end && end > mark.start)

  // A fresh regex per call: matchAll walks lastIndex, and a shared instance would
  // carry that state into the next caller.
  const token = new RegExp(TOKEN.source, TOKEN.flags)
  for (const match of text.matchAll(token)) {
    const marker = match[1]
    const raw = match[2]
    if (raw === undefined) continue
    const start = match.index
    const handle = raw.replace(TRAILING, '')
    if (handle.length === 0) continue

    if (marker === '$') {
      const skill = bySkillId.get(handle.toLowerCase())
      if (skill === undefined) continue
      const end = start + 1 + handle.length
      if (overlaps(start, end)) continue
      marks.push({ start, end, segment: { kind: 'skill', text: `$${handle}`, skill } })
      continue
    }

    if (!handle.includes('/')) continue
    // `@Manor/foo,@Sage` is one token to this regex and two things to the
    // router: a file, then a persona. Clip the path so the persona keeps its chip.
    let end = start + 1 + handle.length
    for (const mark of marks) {
      if (mark.start > start && mark.start < end) end = mark.start
    }
    const path = text.slice(start + 1, end).replace(TRAILING, '')
    if (!path.includes('/')) continue
    const fileEnd = start + 1 + path.length
    if (overlaps(start, fileEnd)) continue
    marks.push({ start, end: fileEnd, segment: { kind: 'file', text: `@${path}`, path } })
  }

  marks.sort((left, right) => left.start - right.start)

  const segments: MentionSegment[] = []
  let at = 0
  for (const mark of marks) {
    if (mark.start < at) continue
    if (mark.start > at) segments.push({ kind: 'text', text: text.slice(at, mark.start) })
    segments.push(mark.segment)
    at = mark.end
  }
  if (at < text.length) segments.push({ kind: 'text', text: text.slice(at) })
  return segments
}

/** The minimum of an mdast node this walk touches. Everything else rides along. */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  /** Where mdast carries instructions for the HTML it becomes. */
  data?: Record<string, unknown>
}

/**
 * The same chips, inside an agent's own markdown: a persona handing work to another
 * persona names it exactly the way the user does, and it should read the same way.
 *
 * Personas only. A file or skill token is a chip in the composer because the user
 * picked it from a menu there; in agent prose a path is prose, and `mentionSegments`
 * hands every segment back with its original text, so leaving those alone loses
 * nothing of what was written. The chip element is a `span` carrying the handle,
 * matched by the component `useAgentMentions` merges in.
 */
export function remarkAgentMentions(agents: readonly AgentConfig[]) {
  return () => (tree: MdNode) => walkChips(tree, (value) => value.includes('@') ? expandChips(mentionSegments(value, agents), false) : null)
}

/**
 * Every chip the sent bubble draws, inside the markdown of a message the user wrote:
 * personas, destinations, skills and file pointers. Here they are chips because they
 * picked them from the composer's menu, so the bubble keeps showing what they picked.
 * Each becomes a `span` carrying what it names, matched by `useMessageChips`.
 */
export function remarkMessageChips(agents: readonly AgentConfig[], skills: readonly SkillConfig[], files: readonly string[] = [], imageCount = 0, quotes: readonly InlineQuote[] = []) {
  const chips = (value: string) =>
    value.includes('@') || value.includes('$') || (imageCount > 0 && value.includes('[Image #')) || (quotes.length > 0 && value.includes('[Quote #'))
      ? expandChips(mentionSegments(value, agents, skills, imageCount, quotes), true)
      : null
  return () => (tree: MdNode) => {
    walkChips(tree, files.length === 0 ? chips : (value) => {
      const parts = value.split(SHIELDED)
      if (parts.length === 1) return chips(value)
      // Odd parts are the captured index of a path `shieldFileChips` set aside.
      return parts.flatMap((part, index): MdNode[] => {
        if (index % 2 === 0) return part === '' ? [] : chips(part) ?? [{ type: 'text', value: part }]
        const path = files[Number(part)] ?? ''
        return [{ type: 'mention', data: { hName: 'span', hProperties: { 'data-file': path } }, children: [{ type: 'text', value: `@${path}` }] }]
      })
    })
    // Inside code and link labels a set-aside path is the text it was.
    if (files.length > 0) restoreShielded(tree, files)
    if (imageCount > 0 || quotes.length > 0) restoreRefs(tree)
  }
}

/**
 * A picture or quote reference keeps its brackets from markdown: right before `(detail)`
 * or `: note` it would otherwise become a link or a definition and its chip would be gone.
 * A private-use mark after the `]` breaks that adjacency; `remarkMessageChips` takes
 * every mark back out, in text, code and raw HTML alike, and nothing else.
 */
export function shieldMessageRefs(text: string, imageCount: number, quoteCount = 0): string {
  if (text.includes(REF_MARK)) return text
  const spans = [...imageRefSpans(text, imageCount), ...quoteRefSpans(text, quoteCount)].sort((left, right) => right.end - left.end)
  let out = text
  for (const span of spans) out = out.slice(0, span.end) + REF_MARK + out.slice(span.end)
  return out
}

const REF_MARK = ''

function restoreRefs(node: MdNode & { url?: string; alt?: string | null; title?: string | null }) {
  const strip = <Field extends string | null | undefined>(field: Field): Field => (field?.includes(REF_MARK) ? field.replaceAll(REF_MARK, '') : field) as Field
  if (node.value !== undefined) node.value = strip(node.value)
  if (node.url !== undefined) node.url = strip(node.url)
  if (node.alt !== undefined) node.alt = strip(node.alt)
  if (node.title !== undefined) node.title = strip(node.title)
  for (const child of node.children ?? []) restoreRefs(child)
}

/** A path set aside from markdown: a private-use pair around its index. */
const SHIELDED = /\uE000(\d+)\uE001/
const MARKDOWN_ACTIVE = /[*_~`\\]/
const MARKDOWN_CLOSERS = /[*_~`]+$/

/**
 * A file chip whose path markdown would read as markup, `@Manor/src/__init__.py`, is
 * set aside before the message is parsed and put back by `remarkMessageChips`, or the
 * underscores turn into bold and split the chip in two. Only those paths: a plain one
 * survives the parse and is found where it lands, inside the bold or code around it.
 * Markup wrapped around the path is not part of it: closers that answer a run still
 * open earlier in the paragraph (`**see @Manor/a_b.ts**`), and a `]` no `[` in the
 * path opened (`[@Manor/a_b.ts](url)`, `[@Manor/a_b.ts][ref]`). `@Manor/src/__tests__`
 * keeps its underscores and `@Manor/app/[id].tsx` its brackets.
 */
export function shieldFileChips(text: string, agents: readonly AgentConfig[]): { text: string; files: string[] } {
  if (!text.includes('@') || text.includes('\uE000')) return { text, files: [] }
  const files: string[] = []
  let out = ''
  let at = 0
  let offset = 0
  for (const segment of mentionSegments(text, agents)) {
    const start = offset
    offset += segment.text.length
    if (segment.kind !== 'file') continue
    const path = unwrapPath(segment.path, text.slice(text.lastIndexOf('\n\n', start) + 1, start))
    if (!path.includes('/') || !MARKDOWN_ACTIVE.test(path)) continue
    // One placeholder per path, so a reference label and its definition still match.
    let index = files.indexOf(path)
    if (index === -1) index = files.push(path) - 1
    out += text.slice(at, start) + `\uE000${index}\uE001`
    at = start + 1 + path.length
  }
  return files.length === 0 ? { text, files } : { text: out + text.slice(at), files }
}

/** `before` is the paragraph up to the `@`, where the openers the path's closers answer sit. */
function unwrapPath(raw: string, before: string): string {
  let depth = 0
  let end = raw.length
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === '[') depth++
    else if (raw[index] === ']' && depth-- === 0) { end = index; break }
  }
  const path = raw.slice(0, end)
  const closers = MARKDOWN_CLOSERS.exec(path)?.[0] ?? ''
  // The outermost closer is last, so try the longest tail first: `__**` closes the
  // `**` before `see` and leaves `__tests__` whole. A run is open when its mirror
  // stands alone an odd number of times before the path.
  for (let length = closers.length; length > 0; length--) {
    const opener = [...closers.slice(-length)].reverse().join('')
    const run = new RegExp(`(?<![*_~\`])${opener.replace(/[*`]/g, '\\$&')}(?![*_~\`])`, 'g')
    if ((before.match(run)?.length ?? 0) % 2 === 1) return path.slice(0, -length)
  }
  return path
}

function restoreShielded(node: MdNode & { url?: string }, files: readonly string[]) {
  const restore = (value: string) => value.replace(new RegExp(SHIELDED.source, 'g'), (_, index: string) => `@${files[Number(index)] ?? ''}`)
  if (node.value !== undefined && node.value.includes('\uE000')) node.value = restore(node.value)
  if (node.url !== undefined && node.url.includes('\uE000')) node.url = restore(node.url)
  for (const child of node.children ?? []) restoreShielded(child, files)
}

/**
 * A single newline is a line break, the way the user typed it. Markdown folds it into a
 * space, which is right for an agent's wrapped prose and wrong for a message whose
 * lines were each pressed out with Shift+Enter. Code keeps its own newlines; it is
 * not a text node.
 */
export function remarkSoftBreaks() {
  return (tree: MdNode) => walkChips(tree, (value) => value.includes('\n')
    ? value.split('\n').flatMap((line, index): MdNode[] => [
        ...(index === 0 ? [] : [{ type: 'break' }]),
        ...(line === '' ? [] : [{ type: 'text', value: line }]),
      ])
    : null, true)
}

function walkChips(node: MdNode, expand: (value: string) => MdNode[] | null, intoLinks = false) {
  const children = node.children
  if (children === undefined) return
  const next: MdNode[] = []
  let changed = false
  for (const child of children) {
    if (child.type === 'text' && child.value !== undefined) {
      const expanded = expand(child.value)
      if (expanded !== null) {
        next.push(...expanded)
        changed = true
        continue
      }
    }
    // Code keeps its handles as typed, and a chip inside a link has nowhere to go; a
    // line break in a link label still is one.
    const link = child.type === 'link' || child.type === 'linkReference'
    if (child.type !== 'code' && child.type !== 'inlineCode' && (intoLinks || !link)) walkChips(child, expand, intoLinks)
    next.push(child)
  }
  if (changed) node.children = next
}

/** What a chip span says it names. Read back by the component that draws it. */
function chipProperties(segment: Exclude<MentionSegment, { kind: 'text' }>): Record<string, string> {
  switch (segment.kind) {
    case 'agent': return { 'data-mention': segment.agent.name }
    case 'skill': return { 'data-skill': segment.skill.id }
    case 'file': return { 'data-file': segment.path }
    case 'image': return { 'data-image': String(segment.number) }
    case 'quote': return { 'data-quote': String(segment.number) }
    default: return { 'data-destination': segment.kind }
  }
}

function expandChips(segments: MentionSegment[], every: boolean): MdNode[] | null {
  const chip = (segment: MentionSegment) => segment.kind !== 'text' && (every || segment.kind === 'agent')
  if (!segments.some(chip)) return null
  return segments.map((segment) =>
    segment.kind !== 'text' && chip(segment)
      ? {
          type: 'mention',
          data: { hName: 'span', hProperties: chipProperties(segment) },
          // The handle as written, so an unresolvable chip still reads as its text.
          children: [{ type: 'text', value: segment.text }],
        }
      : { type: 'text', value: segment.text },
  )
}
