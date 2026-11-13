/**
 * A reference to one of a message's own pictures, `[Image #3]`: the third image in
 * the order it was attached. The composer draws it as a chip and the sent bubble
 * draws it again, but the text itself is all that travels: the store keeps it, every
 * provider reads it as written, and the prompt labels each attached picture with the
 * same number (`imageNote` and `attachmentPathsBlock` on the server). Numbers start
 * at one and count pictures only, never text files or documents.
 */
export const formatImageRef = (number: number): string => `[Image #${number}]`

const IMAGE_REF = /\[Image #([1-9]\d?)\]/g

/** One reference the text holds, with the 1-based number it names. */
export interface RefSpan {
  start: number
  end: number
  number: number
}

/**
 * The references in `text` that name one of `count` pictures. A number past the
 * last picture is not a reference to anything here and stays prose, which is also
 * what keeps a message written before numbering existed exactly as it was.
 */
export function imageRefSpans(text: string, count: number): RefSpan[] {
  if (count <= 0 || !text.includes('[Image #')) return []
  const spans: RefSpan[] = []
  for (const match of text.matchAll(new RegExp(IMAGE_REF.source, 'g'))) {
    const number = Number(match[1])
    if (number > count) continue
    spans.push({ start: match.index, end: match.index + match[0].length, number })
  }
  return spans
}

/**
 * The draft after picture `removed` (1-based) left a tray of `count`: its own
 * references go, with the space that separated them, and every later one moves
 * down by one so it keeps naming the same picture.
 */
export function renumberImageRefs(text: string, removed: number, count: number): string {
  const spans = imageRefSpans(text, count)
  if (spans.length === 0) return text
  let out = ''
  let at = 0
  for (const span of spans) {
    if (span.number !== removed) {
      out += text.slice(at, span.start) + (span.number > removed ? formatImageRef(span.number - 1) : text.slice(span.start, span.end))
      at = span.end
      continue
    }
    let before = text.slice(at, span.start)
    const after = text[span.end]
    // "see [Image #2] and" keeps one space, "like this [Image #2]." loses the one before.
    if (before.endsWith(' ') && (after === undefined || after === ' ' || after === '\n' || /[.,;:!?)]/.test(after))) before = before.slice(0, -1)
    out += before
    at = span.end
  }
  return out + text.slice(at)
}

/**
 * Backspace and Delete in a plain text field take a whole reference, the way the
 * desktop editor's chip goes as one unit. `spans` are the references `previous` holds,
 * pictures and quotes alike. Given the text before and after one edit,
 * an edit that removed part of a reference removes the rest of it too, and keeps
 * whatever was typed or pasted in its place; any other edit comes back unchanged.
 * `caret` is where the caret belongs afterwards.
 *
 * `selection` is the field's selection before the edit. A selected range is exactly
 * what the edit replaced, which the text alone cannot tell: typing `[` over a selected
 * `[Image #1]` and deleting everything but its `[` leave the same diff.
 */
export function snapRefDeletion(previous: string, next: string, spans: readonly { start: number; end: number }[], selection?: { start: number; end: number }): { text: string; caret: number } | null {
  const range = selectedRange(previous, next, selection) ?? diffRange(previous, next)
  if (range === null) return null
  const { start, end, suffix } = range
  const cut = spans.filter((span) => start < span.end && end > span.start)
  if (cut.length === 0) return null
  const inserted = next.slice(start, next.length - suffix)
  const from = Math.min(start, ...cut.map((span) => span.start))
  const to = Math.max(end, ...cut.map((span) => span.end))
  return { text: previous.slice(0, from) + inserted + previous.slice(to), caret: from + inserted.length }
}

/** `previous[start, end)` became what `next` holds before its last `suffix` characters. */
interface EditRange {
  start: number
  end: number
  suffix: number
}

function selectedRange(previous: string, next: string, selection: { start: number; end: number } | undefined): EditRange | null {
  if (selection === undefined || selection.end <= selection.start || selection.end > previous.length) return null
  const suffix = previous.length - selection.end
  const insertedEnd = next.length - suffix
  // Only when the edit really replaced that range; otherwise the diff decides.
  if (insertedEnd < selection.start || !next.startsWith(previous.slice(0, selection.start)) || !next.endsWith(previous.slice(selection.end))) return null
  return { start: selection.start, end: selection.end, suffix }
}

function diffRange(previous: string, next: string): EditRange | null {
  const shortest = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1
  // A pure insertion removed nothing; typed inside a reference, it simply makes it prose.
  return previous.length - suffix > prefix ? { start: prefix, end: previous.length - suffix, suffix } : null
}
