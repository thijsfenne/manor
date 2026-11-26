import { describe, expect, it } from 'vitest'
import type { ClientMessage, MailCard, MailThread, ServerMessage } from '@manor/contracts'
import { createWorkspaceCommands } from './commands'
import { mailCards, NO_MAIL_YET, reduceMail, type MailSnapshot } from './mail'
import { clearRunningTurns, emptyWorkspace, reduce, type WorkspaceState } from './state'

const card = (threadId: string, at: number, over: Partial<MailCard> = {}): MailCard => ({
  threadId,
  subject: `Subject ${threadId}`,
  from: { name: 'Robin Example', address: 'robin@example.com' },
  at,
  unread: true,
  messageCount: 1,
  ...over,
})
const snapshot = (cards: MailCard[]): MailSnapshot => ({
  type: 'mail_state',
  status: 'ready',
  cards,
  syncedAt: 1,
  triage: { lastRunAt: null, running: false },
})
const thread: MailThread = { threadId: 'a', subject: 'Subject a', messages: [], reply: { to: '', cc: '', subject: 'Re: Subject a' } }
const cards = [card('a', 30), card('b', 20), card('c', 10)]

/** The commands over a real store, recording what left. */
function client(connected = true) {
  let state: WorkspaceState = reduce(emptyWorkspace, snapshot(cards))
  const sent: ClientMessage[] = []
  const commands = createWorkspaceCommands(
    (message) => { if (connected) sent.push(message); return connected },
    (change) => { state = change(state) },
  )
  return {
    commands,
    sent,
    hear: (message: ServerMessage) => { state = reduce(state, message) },
    get state() { return state },
    get shown() { return mailCards(state.mail).map((entry) => entry.threadId) },
  }
}

describe('Mail state', () => {
  it('holds the latest mail_state and keeps identity for an unchanged poll', () => {
    const first = reduce(emptyWorkspace, snapshot(cards))
    expect(emptyWorkspace.mail.snapshot).toBeNull()
    expect(first.mail.snapshot?.cards).toEqual(cards)
    expect(reduce(first, snapshot([...cards]))).toBe(first)
    expect(reduce(first, { ...snapshot([]), status: 'off' }).mail.snapshot?.status).toBe('off')
  })

  it('caches a read thread and keeps it when a later read fails', () => {
    const ready: ServerMessage = { type: 'mail_thread', requestId: 'r1', threadId: 'a', result: { status: 'ready', thread } }
    const first = reduce(emptyWorkspace, ready)
    expect(first.mail.threads.a).toEqual(thread)
    expect(reduce(first, { ...ready, requestId: 'r2' })).toBe(first)
    const failed = reduce(first, { type: 'mail_thread', requestId: 'r3', threadId: 'a', result: { status: 'error', message: 'Mailbox unreachable' } })
    expect(failed.mail.threads.a).toEqual(thread)
    expect(failed.mail.threadErrors).toEqual({ a: 'Mailbox unreachable' })
    expect(reduce(failed, ready).mail.threadErrors).toEqual({})
  })

  it('replaces the draft text whole and ignores a streaming frame after the draft ended', () => {
    const frame = (status: 'streaming' | 'done', text: string) =>
      ({ type: 'mail_draft', draftId: 'd1', threadId: 'a', status, text }) as const
    const streaming = reduceMail(reduceMail(NO_MAIL_YET, frame('streaming', 'Dear')), frame('streaming', 'Dear Robin'))
    expect(streaming.drafts.d1).toEqual({ draftId: 'd1', threadId: 'a', status: 'streaming', text: 'Dear Robin' })
    const done = reduceMail(streaming, frame('done', 'Dear Robin,'))
    expect(reduceMail(done, frame('streaming', 'Dear'))).toBe(done)
  })

  it('takes an archived card out at once and keeps it out when the host agrees', () => {
    const app = client()
    app.commands.archiveMailThread('r1', 'b')
    expect(app.sent).toEqual([{ type: 'mail_archive', requestId: 'r1', threadId: 'b' }])
    expect(app.shown).toEqual(['a', 'c'])
    // A poll that was under way still lists it.
    app.hear({ ...snapshot(cards), syncedAt: 2 })
    expect(app.shown).toEqual(['a', 'c'])
    app.hear({ type: 'mail_result', requestId: 'r1', ok: true })
    expect(app.shown).toEqual(['a', 'c'])
    expect(app.state.mail.pending).toEqual([])
    expect(app.state.mail.results.r1).toEqual({ ok: true })
  })

  it('puts the card back when the host refuses the archive', () => {
    const app = client()
    app.commands.archiveMailThread('r1', 'b')
    app.hear({ type: 'mail_result', requestId: 'r1', ok: false, message: 'No archive folder' })
    expect(app.shown).toEqual(['a', 'b', 'c'])
    expect(app.state.mail.results.r1).toEqual({ ok: false, message: 'No archive folder' })
  })

  it('brings an undone archive back in place, before either answer arrives', () => {
    const app = client()
    app.commands.archiveMailThread('r1', 'b')
    app.commands.unarchiveMailThread('r2', 'b')
    expect(app.shown).toEqual(['a', 'b', 'c'])
    app.hear({ type: 'mail_result', requestId: 'r1', ok: true })
    expect(app.shown).toEqual(['a', 'b', 'c'])
    app.hear({ type: 'mail_result', requestId: 'r2', ok: true })
    expect(app.shown).toEqual(['a', 'b', 'c'])
    expect(app.state.mail.snapshot?.cards.map((entry) => entry.threadId)).toEqual(['a', 'b', 'c'])
  })

  it('forgets moves and streaming drafts that a dropped socket left unanswered', () => {
    const app = client()
    app.commands.archiveMailThread('r1', 'b')
    app.commands.startMailDraft('d1', 'a')
    const after = clearRunningTurns(app.state)
    expect(mailCards(after.mail).map((entry) => entry.threadId)).toEqual(['a', 'b', 'c'])
    expect(after.mail.drafts.d1?.status).toBe('error')
  })

  it('shows opening, labelling and linking at once', () => {
    const app = client()
    app.commands.openMailThread('r1', 'a')
    app.commands.setMailLabel('b', 'wait')
    app.commands.linkMailSender('Robin@Example.com', 'garden')
    expect(mailCards(app.state.mail)[0]).toMatchObject({ unread: false, projectId: 'garden' })
    expect(mailCards(app.state.mail)[1]).toMatchObject({ label: 'wait', unread: true, projectId: 'garden' })
    app.commands.linkMailSender('robin@example.com', null)
    expect(mailCards(app.state.mail)[0]).not.toHaveProperty('projectId')
  })

  it('sends every client message and changes nothing when the send did not leave', () => {
    const app = client()
    app.commands.loadMail()
    app.commands.loadMail(true)
    app.commands.runMailTriage()
    app.commands.startMailDraft('d1', 'a', 'Shorter', 'Dear Robin')
    app.commands.stopMailDraft('d1')
    app.commands.sendMail('r9', 'a', 'robin@example.com', 'Thanks', '')
    expect(app.sent).toEqual([
      { type: 'mail_load' },
      { type: 'mail_load', refresh: true },
      { type: 'mail_triage_run' },
      { type: 'mail_draft_start', draftId: 'd1', threadId: 'a', instruction: 'Shorter', current: 'Dear Robin' },
      { type: 'mail_draft_stop', draftId: 'd1' },
      { type: 'mail_send', requestId: 'r9', threadId: 'a', to: 'robin@example.com', body: 'Thanks' },
    ])
    const offline = client(false)
    const before = offline.state
    expect(offline.commands.archiveMailThread('r1', 'b')).toBe(false)
    expect(offline.state).toBe(before)
  })
})
