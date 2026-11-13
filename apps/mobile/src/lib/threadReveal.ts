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
