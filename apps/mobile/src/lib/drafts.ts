import type { ImageAttachment, MessageQuote, MessageReply } from '@manor/contracts'
import type { StagedFile } from '@manor/client-runtime/attachments'

export interface ComposerDraft {
  text: string
  images: ImageAttachment[]
  /** Text, PDF and Word files staged on this draft, kept with it for the same reason pictures are. */
  files: StagedFile[]
  replyTo?: MessageReply
  quote?: MessageQuote
}

export const EMPTY_DRAFT: ComposerDraft = { text: '', images: [], files: [] }

/**
 * Unsent drafts, one per chat, for as long as the app is running.
 *
 * Not screen state, because leaving a chat unmounts the very screen the draft has to
 * survive: the transcript is a route, and coming back to it mounts a new one. Not
 * stored on disk either, the same call the Mac makes — a draft is a thought in
 * progress, and one that outlives a restart is a thought you have to clean up later.
 */
const drafts = new Map<string, ComposerDraft>()

export function readDraft(key: string | undefined): ComposerDraft {
  if (key === undefined) return EMPTY_DRAFT
  return drafts.get(key) ?? EMPTY_DRAFT
}

/**
 * An empty draft is dropped rather than stored, so the map holds only what someone
 * actually typed and a picture-heavy draft's data URLs are released the moment it is
 * sent.
 */
export function writeDraft(key: string | undefined, draft: ComposerDraft): void {
  if (key === undefined) return
  if (draft.text === '' && draft.images.length === 0 && draft.files.length === 0 && draft.replyTo === undefined && draft.quote === undefined) drafts.delete(key)
  else drafts.set(key, draft)
}
