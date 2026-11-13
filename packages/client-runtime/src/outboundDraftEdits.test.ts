import { afterEach, describe, expect, it } from 'vitest'
import { forgetOutboundDraftEdit, observeOutboundDraftEdits, readOutboundDraftEdit, writeOutboundDraftEdit } from './outboundDraftEdits'
import { tallyDrafts, type DraftRecord } from './transcriptState'

const draft: DraftRecord = { key: 'edit-test', draftId: 'edit-test', channel: 'gmail', to: 'qa@example.com', subject: 'Original subject', body: 'Original body' }
afterEach(() => forgetOutboundDraftEdit(draft.draftId))

describe('outbound draft editing', () => {
  it('retains body and an intentionally empty subject when a card remounts', () => {
    writeOutboundDraftEdit(draft.draftId, { ...readOutboundDraftEdit(draft), body: 'My reply', subject: '' })
    expect(readOutboundDraftEdit({ ...draft })).toMatchObject({ body: 'My reply', subject: '' })
    expect(readOutboundDraftEdit({ ...draft, draftId: 'other-recipient' }).body).toBe('Original body')
  })

  it('uses the server revision when a failed submit returns updated content', () => {
    writeOutboundDraftEdit(draft.draftId, { ...readOutboundDraftEdit(draft), body: 'Local edit' })
    const updated = { ...draft, body: 'Submitted content', failure: 'Try again' }
    expect(readOutboundDraftEdit(updated).body).toBe('Submitted content')
  })

  it('drops finished edits explicitly', () => {
    writeOutboundDraftEdit(draft.draftId, { ...readOutboundDraftEdit(draft), body: 'Finished edit' })
    forgetOutboundDraftEdit(draft.draftId)
    expect(readOutboundDraftEdit(draft).body).toBe('Original body')
  })

  it('retains ignored edits and releases a discarded draft without a mounted card', () => {
    writeOutboundDraftEdit(draft.draftId, { ...readOutboundDraftEdit(draft), body: 'Local reply' })
    const event = { id: 'closed', ts: 1, type: 'outbound_draft_closed' as const, agentId: 'marlow', turnId: 'turn', draftId: draft.draftId, channel: 'gmail' as const, to: draft.to }
    observeOutboundDraftEdits({ type: 'event', chatId: 'chat', event: { ...event, outcome: 'ignored' } })
    expect(readOutboundDraftEdit(draft).body).toBe('Local reply')
    observeOutboundDraftEdits({ type: 'event', chatId: 'chat', event: { ...event, outcome: 'discarded' } })
    expect(readOutboundDraftEdit(draft).body).toBe('Original body')
  })

  it('releases recorded deliveries from reconnect snapshots and preserves failed sends', () => {
    const event = { id: 'submission', ts: 1, type: 'outbound_draft_submission' as const, agentId: 'marlow', turnId: 'turn', draftId: draft.draftId, channel: 'gmail' as const, to: draft.to, body: draft.body, submissionId: 'f44feb1b-4259-44e0-9b70-55b142927c5a' }
    writeOutboundDraftEdit(draft.draftId, { ...readOutboundDraftEdit(draft), body: 'Retry edit' })
    observeOutboundDraftEdits({ type: 'snapshot', chatId: 'chat', usage: {}, events: [{ ...event, status: 'failed' }] })
    expect(readOutboundDraftEdit(draft).body).toBe('Retry edit')
    observeOutboundDraftEdits({ type: 'snapshot', chatId: 'chat', usage: {}, events: [{ ...event, status: 'delivered', delivery: 'recorded' }] })
    expect(readOutboundDraftEdit(draft).body).toBe('Original body')
  })

  it('counts uncertain delivery separately from an active send', () => {
    expect(tallyDrafts([
      { ...draft, submission: { status: 'started', body: draft.body } },
      { ...draft, submission: { status: 'uncertain', body: draft.body } },
    ])).toMatchObject({ locked: 1, uncertain: 1, open: 0 })
  })
})


it('retains formatting on remount and invalidates edits when only formatting changes', () => {
  const rich = (bold: boolean) => ({ type: 'rich_text' as const, elements: [{ type: 'rich_text_section' as const, elements: [{ type: 'text' as const, text: 'Same', style: { bold } }] }] })
  const formatted = { ...draft, channel: 'slack' as const, slackRichText: rich(true) }
  writeOutboundDraftEdit(draft.draftId, { ...readOutboundDraftEdit(formatted), body: 'Local' })
  expect(readOutboundDraftEdit(formatted)).toMatchObject({ body: 'Local', slackRichText: rich(true) })
  expect(readOutboundDraftEdit({ ...formatted, slackRichText: rich(false) })).toMatchObject({ body: draft.body, slackRichText: rich(false) })
})
