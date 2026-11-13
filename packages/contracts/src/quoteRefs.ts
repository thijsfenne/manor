import type { InlineQuote, MessageQuote, NoteQuote } from './index.js'
import type { RefSpan } from './imageRefs.js'

/**
 * Where a quote sits in a message, `[Quote #2]`: the second entry of the message's
 * `quotes`. Built like `[Image #n]`: the composer and the sent bubble draw it as a pill,
 * but the text is all that travels, so the store keeps its place and every provider
 * reads it in position, next to the words around it. The prompt prints each quote
 * under the same number (`inlineQuotesNote` on the server).
 */
export const formatQuoteRef = (number: number): string => `[Quote #${number}]`

const QUOTE_REF = /\[Quote #([1-9]\d?)\]/g

/** The highest number a reference can carry, so a draft's list stops growing there. */
export const MAX_QUOTE_REF = 99

/**
 * The references in `text` that name one of `count` quotes. A number past the last
 * quote names nothing and stays prose, which also keeps a message that merely has
 * these words in it, or was written before inline quotes, exactly as it was.
 */
export function quoteRefSpans(text: string, count: number): RefSpan[] {
  if (count <= 0 || !text.includes('[Quote #')) return []
  const spans: RefSpan[] = []
  for (const match of text.matchAll(new RegExp(QUOTE_REF.source, 'g'))) {
    const number = Number(match[1])
    if (number > count) continue
    spans.push({ start: match.index, end: match.index + match[0].length, number })
  }
  return spans
}

/**
 * The draft as it goes out: only the quotes whose pill is still in the text, numbered
 * in reading order. A draft keeps a removed pill's quote so undo can bring it back and
 * keeps numbers stable while it is edited; neither reaches the message.
 */
export function compactQuoteRefs<Quote>(text: string, quotes: readonly Quote[]): { text: string; quotes: Quote[] } {
  const numbers = new Map<number, number>()
  const kept: Quote[] = []
  let out = ''
  let at = 0
  for (const span of quoteRefSpans(text, quotes.length)) {
    let number = numbers.get(span.number)
    if (number === undefined) {
      kept.push(quotes[span.number - 1]!)
      number = kept.length
      numbers.set(span.number, number)
    }
    out += text.slice(at, span.start) + formatQuoteRef(number)
    at = span.end
  }
  return { text: out + text.slice(at), quotes: kept }
}

/**
 * Quotes held beside the words instead of inside them: the phone composer's chip, and
 * what older phone builds send as `quote` and `noteQuote`. They become what the desktop
 * sends, placed after the words, so they meet the same checks on the way in.
 */
export function placeQuotesAfterText(message: {
  text: string
  quotes?: readonly InlineQuote[] | undefined
  quote?: MessageQuote | undefined
  noteQuote?: NoteQuote | undefined
}): { text: string; quotes: InlineQuote[] } {
  const quotes = [...(message.quotes ?? [])]
  let text = message.text
  const place = (quote: InlineQuote) => {
    quotes.push(quote)
    text = `${text.trimEnd()} ${formatQuoteRef(quotes.length)}`.trimStart()
  }
  if (message.quote !== undefined) place({ kind: 'message', ...message.quote })
  if (message.noteQuote !== undefined) place({ kind: 'note', ...message.noteQuote })
  return { text, quotes }
}

/** Every reference moved up by `offset`, for a text whose quotes now follow `offset` others. */
export function offsetQuoteRefs(text: string, count: number, offset: number): string {
  let out = ''
  let at = 0
  for (const span of quoteRefSpans(text, count)) {
    out += text.slice(at, span.start) + formatQuoteRef(span.number + offset)
    at = span.end
  }
  return out + text.slice(at)
}

/** The words a quote holds, whichever surface they were selected on. */
export const quoteText = (quote: InlineQuote): string =>
  quote.kind === 'page' ? quote.context.text || quote.context.label : quote.text

const EXCERPT_CHARS = 18

/** The opening words as a pill shows them, cut by characters rather than code units. */
export function quoteExcerpt(quote: InlineQuote): string {
  const words = Array.from(quoteText(quote).replace(/\s+/g, ' ').trim())
  return `“${words.length > EXCERPT_CHARS ? `${words.slice(0, EXCERPT_CHARS).join('').trimEnd()}…` : words.join('')}`
}

/** A message read as one line, for a surface that draws no pills: the sidebar and banners. */
export function withQuoteExcerpts(text: string, quotes: readonly InlineQuote[] = []): string {
  const spans = quoteRefSpans(text, quotes.length)
  if (spans.length === 0) return text
  let out = ''
  let at = 0
  for (const span of spans) {
    out += text.slice(at, span.start) + quoteExcerpt(quotes[span.number - 1]!)
    at = span.end
  }
  return out + text.slice(at)
}
