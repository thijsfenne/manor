/** How long a request to the Mac may go unanswered before the screen says so. */
export const MAC_ANSWER_WAIT_MS = 10_000

/** What a screen says once that wait has passed. */
export const MAC_SILENT_LINE = 'Your Mac has not answered yet.'

/**
 * The line under a form that sent a request and waits for the Mac's confirmation. The
 * screen marks a request as waited out once `MAC_ANSWER_WAIT_MS` has passed since it was
 * sent; a mark left by an earlier request never makes a new one read as late.
 */
export function sendWaitLine(pendingRequestId: string | null, waitedOutRequestId: string | null): string | null {
  if (pendingRequestId === null) return null
  return waitedOutRequestId === pendingRequestId ? MAC_SILENT_LINE : 'Sending…'
}

/**
 * A question card after Send: open, sent and waiting for the thread to record the answer,
 * or sent when the connection dropped. A reconnect clears what the client knew of waiting
 * questions, so the card unlocks only on a fresh reading of its question from after the
 * drop: an answer that landed takes the question away instead, and nothing is sent twice.
 */
export type SendLock = { kind: 'open' } | { kind: 'sent' } | { kind: 'dropped'; ask: unknown }

export const OPEN_SEND_LOCK: SendLock = { kind: 'open' }
export const SENT_SEND_LOCK: SendLock = { kind: 'sent' }

/** The lock for this render; `ask` is the question as the client derived it last. */
export function settleSendLock(lock: SendLock, live: boolean, ask: unknown): SendLock {
  if (lock.kind === 'open') return lock
  // Offline, the newest reading is still from before the drop.
  if (!live) return lock.kind === 'dropped' && lock.ask === ask ? lock : { kind: 'dropped', ask }
  return lock.kind === 'dropped' && lock.ask !== ask ? OPEN_SEND_LOCK : lock
}
