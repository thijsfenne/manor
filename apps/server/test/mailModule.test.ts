import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '@manor/contracts'
import { FIXTURE_THREAD, MailFixtureSource } from '../src/mailFixtureSource.js'
import { mailReplyFor, MailModule, replySubject } from '../src/mailModule.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

type MailState = Extract<ServerMessage, { type: 'mail_state' }>

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(options: { source?: MailFixtureSource | null; cacheFile?: string; projects?: Set<string> } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-mail-'))
  dirs.push(dir)
  const source = options.source === null ? undefined : options.source ?? new MailFixtureSource({ now: Date.UTC(2026, 10, 26, 12) })
  const projects = options.projects ?? new Set(['project-a'])
  const broadcasts: ServerMessage[] = []
  const cacheFile = options.cacheFile ?? path.join(dir, 'mail-cache.db')
  const module = new MailModule({
    ...(source === undefined ? {} : { source }),
    cacheFile,
    projectIds: async () => projects,
    broadcast: (message) => broadcasts.push(message),
  })
  const replies: ServerMessage[] = []
  const send = (message: Parameters<MailModule['handle']>[0]) => module.handle(message, (reply) => replies.push(reply))
  const lastState = () => broadcasts.filter((message): message is MailState => message.type === 'mail_state').at(-1)!
  const card = (threadId: string) => lastState().cards.find((entry) => entry.threadId === threadId)
  return { module, source: source!, broadcasts, replies, send, lastState, card, cacheFile, projects, dir }
}

describe('MailModule', () => {
  it('is off with no cards when the host has no mailbox', async () => {
    const { send, replies } = setup({ source: null })
    await send({ type: 'mail_load', refresh: true })
    expect(replies).toEqual([{ type: 'mail_state', status: 'off', cards: [], syncedAt: null, triage: { lastRunAt: null, running: false } }])
    await send({ type: 'mail_open', requestId: 'r1', threadId: FIXTURE_THREAD.parking })
    expect(replies.at(-1)).toMatchObject({ type: 'mail_thread', result: { status: 'error' } })
  })

  it('answers from the cache at once and broadcasts the polled Inbox, newest first', async () => {
    const { send, replies, lastState } = setup()
    await send({ type: 'mail_load', refresh: true })
    expect(replies[0]).toMatchObject({ type: 'mail_state', status: 'ready', cards: [], syncedAt: null })
    const state = lastState()
    expect(state.account).toBe('you@example.com')
    expect(state.cards.map((card) => card.threadId)).toEqual([
      FIXTURE_THREAD.interview,
      FIXTURE_THREAD.family,
      FIXTURE_THREAD.parking,
      FIXTURE_THREAD.digest,
      FIXTURE_THREAD.waiting,
      FIXTURE_THREAD.application,
    ])
    expect(state.cards[0]).toMatchObject({ subject: 'Second round interview', messageCount: 2, unread: true })
  })

  it('opening a thread leaves it unread on the source while its card turns read', async () => {
    const { send, replies, source, card, module } = setup()
    await module.refresh()
    const read = vi.spyOn(source, 'readThread')
    await send({ type: 'mail_open', requestId: 'r1', threadId: FIXTURE_THREAD.interview })
    const answer = replies.at(-1)
    expect(answer).toMatchObject({ type: 'mail_thread', requestId: 'r1', result: { status: 'ready' } })
    const thread = answer?.type === 'mail_thread' && answer.result.status === 'ready' ? answer.result.thread : undefined
    // The account's own sent reply is part of the thread.
    expect(thread?.messages.map((message) => message.mine)).toEqual([false, true, false])
    expect(thread?.reply).toEqual({ to: 'nora@talent.example', cc: 'hiring@talent.example', subject: 'Re: Second round interview' })
    expect(card(FIXTURE_THREAD.interview)?.unread).toBe(false)
    const inboxUids = module.cache!.inboxThread(FIXTURE_THREAD.interview)!.uids
    for (const uid of inboxUids) expect(source.seen(uid)).toBe(false)
    // Unchanged Inbox uids: the second open is served from the cache.
    await send({ type: 'mail_open', requestId: 'r2', threadId: FIXTURE_THREAD.interview })
    expect(read).toHaveBeenCalledTimes(1)
    // A new message in the thread makes it unread again and is read fresh.
    source.deliver({ threadId: FIXTURE_THREAD.interview, subject: 'Re: Second round interview', from: { name: 'Nora Example', address: 'nora@talent.example' }, text: 'One more thing.', at: Date.UTC(2026, 10, 26, 13) })
    await module.refresh()
    expect(card(FIXTURE_THREAD.interview)).toMatchObject({ unread: true, messageCount: 3 })
    await send({ type: 'mail_open', requestId: 'r3', threadId: FIXTURE_THREAD.interview })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('archive removes the thread from the Inbox and the state; unarchive brings it back with its label', async () => {
    const { send, replies, source, broadcasts, card, module } = setup()
    await module.refresh()
    await send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.parking, label: 'reply' })
    broadcasts.length = 0
    await send({ type: 'mail_archive', requestId: 'a1', threadId: FIXTURE_THREAD.parking })
    // The card left before the answer arrived.
    const first = broadcasts[0]
    expect(first?.type === 'mail_state' && first.cards.some((entry) => entry.threadId === FIXTURE_THREAD.parking)).toBe(false)
    expect(replies.at(-1)).toEqual({ type: 'mail_result', requestId: 'a1', ok: true })
    expect(source.inInbox(FIXTURE_THREAD.parking)).toBe(false)
    await module.refresh()
    expect(card(FIXTURE_THREAD.parking)).toBeUndefined()

    await send({ type: 'mail_unarchive', requestId: 'u1', threadId: FIXTURE_THREAD.parking })
    expect(replies.at(-1)).toEqual({ type: 'mail_result', requestId: 'u1', ok: true })
    expect(source.inInbox(FIXTURE_THREAD.parking)).toBe(true)
    expect(card(FIXTURE_THREAD.parking)).toMatchObject({ label: 'reply' })
    // The receipt is spent: a second Undo has nothing to undo.
    await send({ type: 'mail_unarchive', requestId: 'u2', threadId: FIXTURE_THREAD.parking })
    expect(replies.at(-1)).toMatchObject({ requestId: 'u2', ok: false })
  })

  it('a failing archive puts the card back and answers ok:false with the reason', async () => {
    const { send, replies, source, broadcasts, card, module } = setup()
    await module.refresh()
    vi.spyOn(source, 'archive').mockRejectedValueOnce(new Error('The mail server refused to archive this thread.'))
    broadcasts.length = 0
    await send({ type: 'mail_archive', requestId: 'a1', threadId: FIXTURE_THREAD.digest })
    const states = broadcasts.filter((message): message is MailState => message.type === 'mail_state')
    expect(states.map((state) => state.cards.some((entry) => entry.threadId === FIXTURE_THREAD.digest))).toEqual([false, true])
    expect(replies.at(-1)).toEqual({ type: 'mail_result', requestId: 'a1', ok: false, message: 'The mail server refused to archive this thread.' })
    expect(card(FIXTURE_THREAD.digest)).toBeDefined()
    expect(source.inInbox(FIXTURE_THREAD.digest)).toBe(true)
  })

  it('a poll that listed the Inbox before an archive does not bring the card back', async () => {
    const { send, source, card, module } = setup()
    await module.refresh()
    let release = () => {}
    const listed = await source.listInbox(200)
    const list = vi.spyOn(source, 'listInbox').mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(listed) }))
    const poll = module.refresh()
    await vi.waitFor(() => expect(list).toHaveBeenCalled())
    const archived = send({ type: 'mail_archive', requestId: 'a1', threadId: FIXTURE_THREAD.family })
    release()
    await Promise.all([poll, archived])
    expect(card(FIXTURE_THREAD.family)).toBeUndefined()
  })

  it('polls one at a time: a request during a poll joins it', async () => {
    const { source, module } = setup()
    const list = vi.spyOn(source, 'listInbox')
    await Promise.all([module.refresh(), module.refresh(), module.refresh()])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('a failed poll broadcasts status error with the cached cards still standing', async () => {
    const { source, module, lastState } = setup()
    await module.refresh()
    vi.spyOn(source, 'listInbox').mockRejectedValueOnce(new Error('Connection timed out'))
    await module.refresh()
    expect(lastState()).toMatchObject({ status: 'error', error: 'Connection timed out' })
    expect(lastState().cards).toHaveLength(6)
    await module.refresh()
    expect(lastState().status).toBe('ready')
    expect(lastState().error).toBeUndefined()
  })

  it('labels and sender links survive a re-sync; a link to a removed project is dropped', async () => {
    const { send, replies, card, module, projects } = setup({ projects: new Set(['project-a', 'project-b']) })
    await module.refresh()
    await send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.family, label: 'reply' })
    await send({ type: 'mail_link_sender', address: 'Parking Services <PARKING@city-council.example>', projectId: 'project-a' })
    await send({ type: 'mail_link_sender', address: 'ingrid@family.example', projectId: 'project-b' })
    await module.refresh()
    expect(card(FIXTURE_THREAD.family)).toMatchObject({ label: 'reply', projectId: 'project-b' })
    expect(card(FIXTURE_THREAD.family)?.reason).toBeUndefined()
    expect(card(FIXTURE_THREAD.parking)?.projectId).toBe('project-a')

    await send({ type: 'mail_link_sender', address: 'ruben@studio.example', projectId: 'project-gone' })
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: 'That project no longer exists.' })

    projects.delete('project-a')
    await module.broadcastState()
    expect(card(FIXTURE_THREAD.parking)?.projectId).toBeUndefined()
    expect(module.cache!.links().has('parking@city-council.example')).toBe(false)
    expect(card(FIXTURE_THREAD.family)?.projectId).toBe('project-b')
  })

  it('an agent label carries its reason and never replaces a label the user set', async () => {
    const { send, card, module } = setup()
    await module.refresh()
    await send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.family, label: 'reply' })
    expect(module.setAgentLabel(FIXTURE_THREAD.family, 'fyi', 'A family note.')).toBe(false)
    expect(module.setAgentLabel(FIXTURE_THREAD.digest, 'fyi', 'A weekly digest, nothing to answer.')).toBe(true)
    await module.broadcastState()
    expect(card(FIXTURE_THREAD.family)).toMatchObject({ label: 'reply' })
    expect(card(FIXTURE_THREAD.digest)).toMatchObject({ label: 'fyi', reason: 'A weekly digest, nothing to answer.' })
    const unlabelled = await module.unlabelled()
    expect(unlabelled.map((entry) => entry.card.threadId)).not.toContain(FIXTURE_THREAD.digest)
    expect(unlabelled.find((entry) => entry.card.threadId === FIXTURE_THREAD.parking)?.snippet).toMatch(/^Dear resident, Your residential parking permit/)
    // Reading for a snippet does not count as opening.
    expect(card(FIXTURE_THREAD.parking)?.unread).toBe(true)
  })

  it('an Undo pressed while the archive still runs waits for it and puts the thread back', async () => {
    const { send, replies, source, module } = setup()
    await module.refresh()
    const archived = send({ type: 'mail_archive', requestId: 'a1', threadId: FIXTURE_THREAD.parking })
    const undone = send({ type: 'mail_unarchive', requestId: 'u1', threadId: FIXTURE_THREAD.parking })
    await Promise.all([archived, undone])
    expect(replies.filter((reply) => reply.type === 'mail_result')).toEqual([
      { type: 'mail_result', requestId: 'a1', ok: true },
      { type: 'mail_result', requestId: 'u1', ok: true },
    ])
    expect(source.inInbox(FIXTURE_THREAD.parking)).toBe(true)
  })

  it('mail that arrives in a labelled thread drops the label, so triage sees the thread again', async () => {
    const { send, source, card, module } = setup()
    await module.refresh()
    await send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.waiting, label: 'wait' })
    await send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.family, label: 'reply' })
    // A delayed answer: the sender dated it before the label, the server took it in after.
    source.deliver({ threadId: FIXTURE_THREAD.waiting, subject: 'Re: Quote', from: { name: 'Studio', address: 'studio@print.example' }, text: 'Here is the quote.', at: 0, receivedAt: Date.now() + 60_000 })
    await module.refresh()
    expect(card(FIXTURE_THREAD.waiting)?.label).toBeUndefined()
    expect(card(FIXTURE_THREAD.family)).toMatchObject({ label: 'reply' })
    expect((await module.unlabelled()).map((entry) => entry.card.threadId)).toContain(FIXTURE_THREAD.waiting)
  })

  it('a uidValidity change rebuilds the message rows and drops bodies read under the old numbering', async () => {
    const { send, source, card, module } = setup()
    await module.refresh()
    await send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.interview, label: 'wait' })
    await send({ type: 'mail_open', requestId: 'r1', threadId: FIXTURE_THREAD.interview })
    const before = module.cache!.inboxThread(FIXTURE_THREAD.interview)!
    expect(module.cachedThread(FIXTURE_THREAD.interview)).toBeDefined()
    source.renumber('2', 1000)
    await module.refresh()
    const after = module.cache!.inboxThread(FIXTURE_THREAD.interview)!
    expect(after.uidValidity).toBe('2')
    expect(after.uids).toEqual(before.uids.map((uid) => uid + 1000))
    expect(module.cachedThread(FIXTURE_THREAD.interview)).toBeUndefined()
    // The opened mark was a uid; under the new numbering the thread reads as the server has it.
    expect(card(FIXTURE_THREAD.interview)).toMatchObject({ unread: true, label: 'wait' })
  })

  it('a message a poll adds while a thread is being read stays unread', async () => {
    const { send, source, card, module } = setup()
    await module.refresh()
    const read = source.readThread.bind(source)
    let release = () => {}
    vi.spyOn(source, 'readThread').mockImplementationOnce(async (thread) => {
      const messages = await read(thread)
      await new Promise<void>((resolve) => { release = resolve })
      return messages
    })
    const opening = send({ type: 'mail_open', requestId: 'r1', threadId: FIXTURE_THREAD.family })
    await vi.waitFor(() => expect(source.readThread).toHaveBeenCalled())
    source.deliver({ threadId: FIXTURE_THREAD.family, subject: 'Re: Komen jullie zondag eten?', from: { name: 'Ingrid Example', address: 'ingrid@family.example' }, text: 'Of zaterdag?', at: Date.UTC(2026, 10, 26, 13) })
    await module.refresh()
    release()
    await opening
    expect(card(FIXTURE_THREAD.family)).toMatchObject({ unread: true, messageCount: 2 })
  })

  it('a cache found damaged while running starts again empty and refills on the next poll', async () => {
    const { module, lastState } = setup()
    await module.refresh()
    vi.spyOn(module.cache!, 'cards').mockImplementationOnce(() => {
      throw Object.assign(new Error('database disk image is malformed'), { errcode: 11 })
    })
    expect((await module.state()).cards).toEqual([])
    await module.refresh()
    expect(lastState().cards).toHaveLength(6)
  })

  it('refuses a send on a host without a send port', async () => {
    const { send, replies, module } = setup()
    await module.refresh()
    await send({ type: 'mail_send', requestId: 's1', threadId: FIXTURE_THREAD.family, to: 'ingrid@family.example', body: 'Ja!' })
    expect(replies.at(-1)).toMatchObject({ type: 'mail_result', requestId: 's1', ok: false })
  })
})

describe('the cache file is disposable', () => {
  async function labelledAndClosed() {
    const first = setup()
    await first.module.refresh()
    await first.send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.family, label: 'reply' })
    first.module.cache!.close()
    return first
  }

  async function reopenAndSync(cacheFile: string) {
    const second = setup({ cacheFile })
    await second.send({ type: 'mail_load' })
    expect(second.replies.at(-1)).toMatchObject({ type: 'mail_state', cards: [] })
    await second.module.refresh()
    expect(second.lastState().cards).toHaveLength(6)
    expect(second.card(FIXTURE_THREAD.family)?.label).toBeUndefined()
  }

  it('a deleted file costs only a refetch', async () => {
    const { cacheFile } = await labelledAndClosed()
    rmSync(cacheFile)
    await reopenAndSync(cacheFile)
  })

  it('a corrupt file costs only a refetch', async () => {
    const { cacheFile } = await labelledAndClosed()
    writeFileSync(cacheFile, 'this is not a database, just bytes '.repeat(200))
    await reopenAndSync(cacheFile)
  })

  it('a cache written for another mailbox is emptied, labels and links included', async () => {
    const { cacheFile } = await labelledAndClosed()
    const other = new MailFixtureSource({ now: Date.UTC(2026, 10, 26, 12) })
    vi.spyOn(other, 'account').mockReturnValue('someone@else.example')
    const second = setup({ source: other, cacheFile })
    expect((await second.module.state()).cards).toEqual([])
    await second.module.refresh()
    expect(second.card(FIXTURE_THREAD.family)?.label).toBeUndefined()
  })

  it('a file on another schema version is emptied', async () => {
    const { cacheFile } = await labelledAndClosed()
    const db = new DatabaseSync(cacheFile)
    db.exec('CREATE TABLE stray (x); PRAGMA user_version = 99')
    db.close()
    await reopenAndSync(cacheFile)
  })
})

describe('mailReplyFor', () => {
  const message = (from: string, to: string[], cc: string[] = []) => ({
    id: from,
    from: { name: '', address: from },
    to: to.map((address) => ({ name: '', address })),
    cc: cc.map((address) => ({ name: '', address })),
    at: 0,
    text: '',
    truncated: false,
    attachments: [],
    mine: from === 'you@home.example',
  })

  it('answers the newest sender that is not the account, copying the rest minus the account', () => {
    expect(mailReplyFor([
      message('a@one.example', ['you@home.example', 'b@one.example'], ['c@one.example']),
      message('you@home.example', ['a@one.example']),
    ], 'You@Home.example', 'Plans')).toEqual({ to: 'a@one.example', cc: 'b@one.example, c@one.example', subject: 'Re: Plans' })
  })

  it('follows up to the newest recipients when the account wrote every message', () => {
    expect(mailReplyFor([message('you@home.example', ['ruben@studio.example'])], 'you@home.example', 'Quote').to).toBe('ruben@studio.example')
  })

  it('puts one recipient in To and the others in Cc, because the send path takes one To', () => {
    expect(mailReplyFor([message('you@home.example', ['a@one.example', 'b@one.example'], ['c@one.example'])], 'you@home.example', 'Quote'))
      .toMatchObject({ to: 'a@one.example', cc: 'b@one.example, c@one.example' })
  })

  it('skips a newest message whose sender has no usable address', () => {
    expect(mailReplyFor([
      message('a@one.example', ['you@home.example']),
      message('undisclosed', ['you@home.example']),
    ], 'you@home.example', 'Plans').to).toBe('a@one.example')
  })

  it('never doubles Re:', () => {
    expect(replySubject('Re: RE: Plans')).toBe('Re: Plans')
    expect(replySubject('Plans')).toBe('Re: Plans')
  })
})
