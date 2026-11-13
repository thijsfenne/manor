import { setWorkChangesOpen } from '@manor/client-runtime/work-proposals'
import type { Chat, WorkHandoff } from '@manor/contracts'
import { EMPTY_DRAFT, forgetDrafts, readDraft, writeDraft } from './composerDrafts'
import { requestOutcome, type RequestEvents } from './useRequest'

/**
 * What the user is writing under Request changes, one draft per Session result, kept with
 * the composer's drafts so it survives the navigation that unmounts the field. The card
 * in the briefing chat and the Diff panel's bar read the same one.
 */
const PREFIX = 'work-changes:'

export const workChangesKey = (handoffId: string): string => `${PREFIX}${handoffId}`

export const readWorkChanges = (handoffId: string): string => readDraft(workChangesKey(handoffId)).text

export function writeWorkChanges(handoffId: string, text: string): void {
  writeDraft(workChangesKey(handoffId), { ...EMPTY_DRAFT, text })
}

/** The most a Session takes in one Request changes, the same cap as the wire. */
export const WORK_CHANGES_LIMIT = 40_000

/**
 * Sends feedback, then closes the field and drops its draft once the server takes it.
 * The listener is not the field's: leaving the screen right after Send unmounts it, and
 * the card's own request listener is swapped out as soon as the Session works again,
 * which comes before the answer. Left open, the field would greet the next result.
 * Text written since the send stays.
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
    if (outcome !== 'ack') return
    setWorkChangesOpen(handoffId, false)
    if (readWorkChanges(handoffId).trim() === text) writeDraft(workChangesKey(handoffId), EMPTY_DRAFT)
  })
  if (send()) return true
  stop()
  return false
}

/** The same test the card uses for a result the user can still ask to change. */
function resultCanChange(handoff: WorkHandoff, chats: readonly Chat[]): boolean {
  if (handoff.state !== 'active' || handoff.goalConfirmedAt !== undefined) return false
  const session = chats.find((chat) => chat.id === handoff.workChatId)
  return session !== undefined && session.settledAt === null && session.archivedAt === null
}

/** Drops the feedback of every result that was confirmed, withdrawn or closed since it was written. */
export function forgetClosedWorkChanges(handoffs: readonly WorkHandoff[], chats: readonly Chat[]): void {
  const open = new Set(handoffs.filter((handoff) => resultCanChange(handoff, chats)).map((handoff) => handoff.id))
  forgetDrafts((key) => key.startsWith(PREFIX) && !open.has(key.slice(PREFIX.length)))
}
