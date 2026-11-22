/**
 * Show in chat on a DM's Files screen, or a message picked in Search: the transcript
 * event to land on. The screen leaves it here and goes back or opens the chat; the chat
 * takes it on focus and scrolls to the row holding that event once its thread holds it.
 */
let pendingEvent: { chatId: string; eventId: string } | null = null

export function leaveEventReveal(chatId: string, eventId: string) {
  pendingEvent = { chatId, eventId }
}

/** The event this chat should show, once. */
export function takeEventReveal(chatId: string): string | null {
  if (pendingEvent === null || pendingEvent.chatId !== chatId) return null
  const { eventId } = pendingEvent
  pendingEvent = null
  return eventId
}
