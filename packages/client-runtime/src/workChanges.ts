import type { Chat, ImageAttachment, WorkHandoff } from '@manor/contracts'
import { setWorkChangesOpen } from './workProposals'

/**
 * What the user is writing under Request changes, one text per Session result. Kept
 * outside the card, because the card is unmounted by the very things the text has to
 * survive: leaving the screen, and on the phone a row scrolling out of the list. Every
 * surface that shows the field reads the same text.
 */
const texts = new Map<string, string>()
/** The pictures pasted into the same field on the phone, kept beside its text for the same reason. */
const pictures = new Map<string, readonly ImageAttachment[]>()
const listeners = new Set<() => void>()
const NO_PICTURES: readonly ImageAttachment[] = []
const notify = () => { for (const listener of listeners) listener() }

/** The most a Session takes in one Request changes, the same cap as the wire. */
export const WORK_CHANGES_LIMIT = 40_000

export function subscribeWorkChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const readWorkChanges = (handoffId: string): string => texts.get(handoffId) ?? ''

/** An empty text is dropped rather than stored, so the map holds only what someone wrote. */
export function writeWorkChanges(handoffId: string, text: string): void {
  if (readWorkChanges(handoffId) === text) return
  if (text === '') texts.delete(handoffId)
  else texts.set(handoffId, text)
  notify()
}

/** Always the same array for a field without pictures, so a reader that compares sees no change. */
export const readWorkChangeImages = (handoffId: string): readonly ImageAttachment[] => pictures.get(handoffId) ?? NO_PICTURES

export function writeWorkChangeImages(handoffId: string, images: readonly ImageAttachment[]): void {
  if (readWorkChangeImages(handoffId) === images) return
  if (images.length === 0) pictures.delete(handoffId)
  else pictures.set(handoffId, images)
  notify()
}

/**
 * The server took the feedback: the field closes and its text and pictures go. Call it
 * from the send's own answer and not from the card, which may be gone by then. Left open,
 * the field would greet the next result. Text written and pictures pasted since the send stay.
 */
export function settleWorkChanges(handoffId: string, sent: string, sentImages: readonly ImageAttachment[] = NO_PICTURES): void {
  setWorkChangesOpen(handoffId, false)
  if (readWorkChanges(handoffId).trim() === sent) writeWorkChanges(handoffId, '')
  const kept = readWorkChangeImages(handoffId).filter((image) => !sentImages.includes(image))
  writeWorkChangeImages(handoffId, kept.length === 0 ? NO_PICTURES : kept)
}

/** The same test the card uses for a result the user can still ask to change. */
function resultCanChange(handoff: WorkHandoff, chats: readonly Chat[]): boolean {
  if (handoff.state !== 'active' || handoff.goalConfirmedAt !== undefined) return false
  const session = chats.find((chat) => chat.id === handoff.workChatId)
  return session !== undefined && session.settledAt === null && session.archivedAt === null
}

/**
 * Drops the feedback of every result that was confirmed, withdrawn or closed since it
 * was written. Each client runs it on its own snapshot, or the texts are never let go.
 */
export function forgetClosedWorkChanges(handoffs: readonly WorkHandoff[], chats: readonly Chat[]): void {
  if (texts.size === 0 && pictures.size === 0) return
  const open = new Set(handoffs.filter((handoff) => resultCanChange(handoff, chats)).map((handoff) => handoff.id))
  const closed = [...new Set([...texts.keys(), ...pictures.keys()])].filter((handoffId) => !open.has(handoffId))
  for (const handoffId of closed) {
    texts.delete(handoffId)
    pictures.delete(handoffId)
  }
  if (closed.length > 0) notify()
}

/** Test seam. Nothing in the app forgets every text at once. */
export function clearWorkChanges(): void {
  texts.clear()
  pictures.clear()
}
