import { MAX_MESSAGE_ATTACHMENTS, type DocumentUpload, type FileAttachment, type ImageAttachment, type InlineQuote } from '@manor/contracts'
import { insertQuote } from '@manor/client-runtime/message-quotes'
import { stagedImageSlots, type DraftImage } from './imageMarks'

export interface ComposerDraft {
  text: string
  /** A marked picture also holds its unmarked original; see `DraftImage`. */
  images: DraftImage[]
  /** Text files staged on this draft, kept with it for the same reason pictures are. */
  files: FileAttachment[]
  /** PDF and Word originals, held as base64 until the send extracts them server-side. */
  documents?: DocumentUpload[]
  /** What the text's `[Quote #n]` pills name. A removed pill's quote stays so undo finds it. */
  quotes?: InlineQuote[]
}

export const EMPTY_DRAFT: ComposerDraft = { text: '', images: [], files: [], documents: [] }

/**
 * The new-chat stage's own slot. Every other key is a chat id, and those are
 * uuids, so this cannot be one of them.
 */
export const NEW_CHAT_DRAFT_KEY = 'new-chat'

/**
 * Unsent drafts, one per chat, for the lifetime of the tab.
 *
 * Not component state, because the composer holding a draft is unmounted or
 * repurposed by the very navigation the draft has to survive: opening another
 * chat hands the same composer a different key, and opening the new-chat stage
 * takes the footer one off screen entirely. Not persisted either — a draft is a
 * thought in progress, and one that outlives a reload is a thought you have to
 * clean up later.
 */
const drafts = new Map<string, ComposerDraft>()

export function readDraft(key: string | undefined): ComposerDraft {
  if (key === undefined) return EMPTY_DRAFT
  return drafts.get(key) ?? EMPTY_DRAFT
}

/**
 * An empty draft is dropped rather than stored, so the map holds only what
 * someone actually typed and a picture-heavy draft's data URLs are released the
 * moment it is sent.
 */
export function writeDraft(key: string | undefined, draft: ComposerDraft): void {
  if (key === undefined) return
  if (draft.text === '' && draft.images.length === 0 && draft.files.length === 0 && (draft.documents?.length ?? 0) === 0) drafts.delete(key)
  else drafts.set(key, draft)
}

/** Test seam. Nothing in the app forgets every draft at once. */
export function clearDrafts(): void {
  drafts.clear()
}

/** Composers on screen, by draft key, that take text handed in from elsewhere. */
const inserts = new Map<string, Set<(insert: DraftInsert) => void>>()

export type DraftInsert =
  | { kind: 'text'; text: string }
  | { kind: 'quote'; quote: InlineQuote }
  /** A picture from the transcript to mark up; it joins the draft only on the editor's Done. */
  | { kind: 'annotate'; image: ImageAttachment }

/** The mounted composer for `key` takes what a surface outside it hands in. */
export function subscribeDraftInsert(key: string, listener: (insert: DraftInsert) => void): () => void {
  const listeners = inserts.get(key) ?? new Set()
  listeners.add(listener)
  inserts.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) inserts.delete(key)
  }
}

/** `text` after what is already there, a space between them. */
export const appendedText = (draft: string, text: string): string =>
  draft.length === 0 || /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`

/**
 * Adds text to the end of a chat's draft, the way a diff's "Reference in chat" hands a
 * file to the composer: live into the composer on screen, else into the parked draft
 * it picks up when it opens.
 */
export function insertIntoDraft(key: string, text: string): void {
  if (deliverInsert(key, { kind: 'text', text })) return
  const draft = readDraft(key)
  writeDraft(key, { ...draft, text: appendedText(draft.text, text) })
}

/**
 * Places a quote in a chat's draft: at the caret of the composer on screen, which also
 * says so when the message is full, else at the end of the parked draft.
 */
export function insertQuoteIntoDraft(key: string, quote: InlineQuote): void {
  if (deliverInsert(key, { kind: 'quote', quote })) return
  const draft = readDraft(key)
  const next = insertQuote(draft.text, draft.quotes ?? [], quote, draft.text.length)
  if (next !== null) writeDraft(key, { ...draft, text: next.text, quotes: next.quotes })
}

/**
 * Opens the editor of the composer on screen over a picture from the transcript. With
 * no composer on screen the picture joins the parked draft unmarked, so it is not lost.
 */
export function annotateIntoDraft(key: string, image: ImageAttachment): void {
  if (deliverInsert(key, { kind: 'annotate', image })) return
  const draft = readDraft(key)
  if (stagedImageSlots(draft.images) + draft.files.length + (draft.documents?.length ?? 0) >= MAX_MESSAGE_ATTACHMENTS) return
  writeDraft(key, { ...draft, images: [...draft.images, image] })
}

function deliverInsert(key: string, insert: DraftInsert): boolean {
  const listeners = inserts.get(key)
  if (listeners === undefined || listeners.size === 0) return false
  for (const listener of listeners) listener(insert)
  return true
}
