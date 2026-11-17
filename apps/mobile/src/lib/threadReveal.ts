/**
 * A proposal row on a project's Sessions screen has no chat of its own: its card,
 * with Accept, sits in the thread. The Sessions screen leaves the row key here and
 * goes back; the thread takes it when it is in focus again and scrolls to the card.
 */
let pending: { threadId: string; rowKey: string } | null = null

export function leaveThreadReveal(threadId: string, rowKey: string) {
  pending = { threadId, rowKey }
}

/** The row this thread should show, once. */
export function takeThreadReveal(threadId: string): string | null {
  if (pending === null || pending.threadId !== threadId) return null
  const { rowKey } = pending
  pending = null
  return rowKey
}

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
