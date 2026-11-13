import { formatQuoteRef, isSoloRoom, MAX_MESSAGE_QUOTES, MAX_QUOTE_REF, MessageQuoteSchema, NoteQuoteSchema, quoteRefSpans, SINGLE_CHAT_VOICE, type AgentConfig, type Chat, type InlineQuote, type MessageQuote, type NoteQuote } from '@manor/contracts'

/** Validates text already selected by a platform selection API. */
export function quoteFromText(eventId: string, text: string, agentId?: string): MessageQuote | undefined {
  const parsed = MessageQuoteSchema.safeParse({ eventId, text, ...(agentId === undefined ? {} : { agentId }) })
  return parsed.success ? parsed.data : undefined
}

/** Turns one native or DOM selection into the exact snapshot accepted by the wire. */
export function quoteFromRange(
  eventId: string,
  text: string,
  start: number,
  end: number,
  agentId?: string,
): MessageQuote | undefined {
  const from = Math.max(0, Math.min(start, end))
  const to = Math.min(text.length, Math.max(start, end))
  const selected = text.slice(from, to)
  return quoteFromText(eventId, selected, agentId)
}

/** Selected text from a Knowledge note, with the note's vault-relative path. */
export function quoteFromNote(path: string, text: string): NoteQuote | undefined {
  const parsed = NoteQuoteSchema.safeParse({ path, text })
  return parsed.success ? parsed.data : undefined
}

/** A word that follows here reads on without a space before it. */
const CLINGS_TO_PREVIOUS = /^[\s.,;:!?)]/

/**
 * A draft with `quote` placed at `caret`, set off from the words around it and with the
 * caret just past it. The quote joins the end of the draft's list, whose numbers hold
 * until the send (`compactQuoteRefs`). Null when the message has no room for another;
 * a browser selection already in the draft comes back as it was.
 */
export function insertQuote(
  text: string,
  quotes: readonly InlineQuote[],
  quote: InlineQuote,
  caret: number,
): { text: string; quotes: InlineQuote[]; caret: number } | null {
  const live = new Set(quoteRefSpans(text, quotes.length).map((span) => span.number))
  const placed = quote.kind !== 'page' ? -1 : quotes.findIndex((other, index) => other.kind === 'page' && other.context.id === quote.context.id && live.has(index + 1))
  if (placed !== -1) return { text, quotes: [...quotes], caret }
  if (live.size >= MAX_MESSAGE_QUOTES || quotes.length >= MAX_QUOTE_REF) return null
  const at = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = CLINGS_TO_PREVIOUS.test(after) ? '' : ' '
  const inserted = `${lead}${formatQuoteRef(quotes.length + 1)}${trail}`
  return { text: before + inserted + after, quotes: [...quotes, quote], caret: at + inserted.length }
}

/**
 * Whether a sent quote says who wrote it. Only a room with several personas has an
 * author worth naming: a DM, a Single Session and a project thread have one other voice.
 */
export function quoteNamesAuthor(chat: Pick<Chat, 'kind' | 'mode'>, projectThread: boolean) {
  return !projectThread && !isSoloRoom(chat) && chat.kind !== 'subagent'
}

/**
 * The author line of a sent quote, or undefined when it should not show. A bare
 * session voice and an author no longer in the roster have no name worth printing.
 */
export function quoteAuthorName(
  quote: MessageQuote,
  agents: readonly AgentConfig[],
  showAuthor: boolean,
  you = 'You',
) {
  if (!showAuthor) return undefined
  if (quote.agentId === undefined) return you
  if (quote.agentId === SINGLE_CHAT_VOICE.id) return undefined
  return agents.find((agent) => agent.id === quote.agentId)?.name
}
