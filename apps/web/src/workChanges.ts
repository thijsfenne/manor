import { settleWorkChanges } from '@manor/client-runtime/work-changes'
import { requestOutcome, type RequestEvents } from './useRequest'

/**
 * Sends Request changes feedback, then settles its field once the server takes it.
 * The listener is not the field's: leaving the screen right after Send unmounts it, and
 * the card's own request listener is swapped out as soon as the Session works again,
 * which comes before the answer.
 */
export function sendWorkChanges(
  events: RequestEvents,
  handoffId: string,
  text: string,
  requestId: string,
  send: () => boolean,
): boolean {
  const stop = events.subscribe((response) => {
    const outcome = requestOutcome(requestId, response)
    if (outcome === null) return
    stop()
    if (outcome === 'ack') settleWorkChanges(handoffId, text)
  })
  if (send()) return true
  stop()
  return false
}
