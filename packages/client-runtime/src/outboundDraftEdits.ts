import type { ServerMessage, SlackRichText } from '@manor/contracts'
import type { DraftRecord } from './transcriptState'

export interface OutboundDraftEdit {
  revision: string
  body: string
  slackRichText?: SlackRichText
  subject: string
}

// Like composer drafts, edits survive navigation for this client session. Keeping
// them outside the card also preserves them when a group becomes a single card.
const edits = new Map<string, OutboundDraftEdit>()

export function outboundDraftRevision(draft: DraftRecord): string {
  return `${draft.draftId}\0${draft.body}\0${draft.subject ?? ''}\0${draft.failure ?? ''}\0${JSON.stringify(draft.slackRichText) ?? ''}`
}

export function readOutboundDraftEdit(draft: DraftRecord): OutboundDraftEdit {
  const revision = outboundDraftRevision(draft)
  const saved = edits.get(draft.draftId)
  if (saved?.revision === revision) return saved
  edits.delete(draft.draftId)
  return { revision, body: draft.body, subject: draft.subject ?? '', ...(draft.slackRichText === undefined ? {} : { slackRichText: draft.slackRichText }) }
}

export function writeOutboundDraftEdit(draftId: string, edit: OutboundDraftEdit): void {
  edits.set(draftId, edit)
}

export function forgetOutboundDraftEdit(draftId: string): void {
  edits.delete(draftId)
}

/** Release completed drafts even when their card has already left the dock. */
export function observeOutboundDraftEdits(message: ServerMessage): void {
  const events = message.type === 'event' ? [message.event] : message.type === 'snapshot' ? message.events : []
  for (const event of events) {
    if (
      (event.type === 'outbound_draft_submission' && event.status === 'delivered') ||
      (event.type === 'outbound_draft_closed' && (event.outcome === 'submitted' || event.outcome === 'discarded'))
    ) forgetOutboundDraftEdit(event.draftId)
  }
}
