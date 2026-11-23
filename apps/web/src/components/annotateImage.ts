import { eventImageSource, type EventImage } from '@manor/contracts'
import { createContext } from 'react'
import { shrinkChatImage } from '../chatImages'
import { annotateIntoDraft } from '../composerDrafts'
import { fetchImageAttachment } from '../imageMarks'

/**
 * Opens a transcript picture in its chat composer's mark-up editor. Absent where no
 * composer of that chat can take the result, so those pictures offer no Annotate.
 */
export const AnnotateImageContext = createContext<((image: EventImage) => Promise<void>) | undefined>(undefined)

// One per chat, so the context value keeps its identity and memoised bubbles stay put.
const handlers = new Map<string, (image: EventImage) => Promise<void>>()

export function annotateImageFor(chatId: string): (image: EventImage) => Promise<void> {
  let handler = handlers.get(chatId)
  if (handler === undefined) {
    handler = async (image) => annotateIntoDraft(chatId, await fetchImageAttachment(eventImageSource(image), image.name, shrinkChatImage))
    handlers.set(chatId, handler)
  }
  return handler
}
