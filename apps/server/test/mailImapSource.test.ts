import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MailImapSource, mailImapSourceFromEnv, type MailImapClient } from '../src/mailImapSource.js'

interface FakeMessage {
  emailId: string
  threadId: string
  messageId: string
  subject: string
  from: { name: string; address: string }
  to: { name: string; address: string }[]
  date: Date
  seen: boolean
  /** Uid in all mail (Gmail) or in the folder it sits in (plain IMAP). */
  allUid: number
  /** Uid in the Inbox while it is there. */
  inboxUid?: number
  /** Where it sits on a plain IMAP server without all mail. */
  folder?: string
  structure: Record<string, unknown>
  body: string
}

const plain = { type: 'text/plain', parameters: { charset: 'utf-8' } }
const htmlOnly = { type: 'text/html', parameters: { charset: 'utf-8' } }

/**
 * A recording stand-in for imapflow over a tiny mailbox. Every method the source touches
 * is logged by name with its arguments, so a test can assert the exact commands, and any
 * method this fake does not have (a flag setter, say) fails the test loudly.
 */
function fakeServer(options: { gmail: boolean; messages: FakeMessage[]; move?: boolean }) {
  const calls: { method: string; args: unknown[] }[] = []
  let nextInboxUid = 100
  let selected = ''
  const all = '[Gmail]/All Mail'
  const inbox = () => options.messages.filter((message) => message.inboxUid !== undefined).sort((left, right) => left.inboxUid! - right.inboxUid!)
  const inSelected = () => {
    if (selected === 'INBOX') return inbox().map((message) => ({ message, uid: message.inboxUid! }))
    if (selected === all) return options.messages.map((message) => ({ message, uid: message.allUid }))
    return options.messages.filter((message) => message.folder === selected).map((message) => ({ message, uid: message.allUid }))
  }
  const byUids = (range: string) => {
    const uids = range.split(',').map(Number)
    return inSelected().filter((entry) => uids.includes(entry.uid))
  }
  const client = {
    capabilities: new Map<string, boolean>([
      ...(options.gmail ? [['X-GM-EXT-1', true] as const] : []),
      ...(options.move === false ? [] : [['MOVE', true] as const]),
    ]),
    get mailbox() {
      return selected === '' ? false : { path: selected, uidValidity: 7n, exists: inSelected().length }
    },
    async connect() {},
    async logout() {},
    async list() {
      return options.gmail
        ? [{ path: 'INBOX' }, { path: all, specialUse: '\\All' }]
        : [{ path: 'INBOX' }, { path: 'Archive', specialUse: '\\Archive' }]
    },
    async getMailboxLock(path: string) {
      selected = path
      return { path, release: () => { selected = '' } }
    },
    async search(query: { threadId?: string; emailId?: string; header?: Record<string, string> }) {
      return inSelected()
        .filter(({ message }) =>
          (query.threadId === undefined || message.threadId === query.threadId) &&
          (query.emailId === undefined || message.emailId === query.emailId) &&
          (query.header?.['message-id'] === undefined || message.messageId === query.header['message-id']))
        .map((entry) => entry.uid)
    },
    async *fetch(range: string, query: Record<string, unknown>, fetchOptions?: { uid?: boolean }) {
      const entries = fetchOptions?.uid === true
        ? byUids(range)
        : inSelected().slice(Number(range.split(':')[0]) - 1)
      for (const { message, uid } of entries) {
        yield {
          seq: 0,
          uid,
          ...(options.gmail ? { emailId: message.emailId } : {}),
          ...(options.gmail && query['threadId'] === true ? { threadId: message.threadId } : {}),
          flags: new Set(message.seen ? ['\\Seen'] : []),
          envelope: { date: message.date, subject: message.subject, messageId: message.messageId, from: [message.from], to: message.to, cc: [] },
          // The server took each message in an hour after its sender dated it.
          ...(query['internalDate'] === true ? { internalDate: new Date(message.date.getTime() + 3_600_000) } : {}),
          ...(query['bodyStructure'] === true ? { bodyStructure: message.structure } : {}),
        }
      }
    },
    async download(uid: string, part: string) {
      const found = byUids(uid)[0]!
      return { meta: { charset: 'utf-8', part }, content: Readable.from([Buffer.from(found.message.body)]) }
    },
    async messageMove(range: string, destination: string) {
      for (const { message } of byUids(range)) {
        if (destination === 'INBOX') {
          message.folder = undefined
          message.inboxUid = nextInboxUid++
        } else if (destination === all) {
          message.inboxUid = undefined
        } else {
          message.inboxUid = undefined
          message.folder = destination
        }
      }
      return { path: selected, destination }
    },
    async messageCopy(range: string, destination: string) {
      if (destination === 'INBOX') for (const { message } of byUids(range)) message.inboxUid = nextInboxUid++
      return { path: selected, destination }
    },
  }
  const recording = new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push({ method: String(key), args })
        return (value as (...inner: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return { client: recording as unknown as MailImapClient, calls }
}

const sam = { name: 'Sam Field', address: 'sam@one.example' }
const me = { name: 'You', address: 'you@home.example' }

function gmailMailbox() {
  const messages: FakeMessage[] = [
    {
      emailId: 'e1', threadId: '1790000000000000077', messageId: '<a@one.example>', subject: 'Plans', from: sam, to: [me],
      date: new Date('2026-11-20T09:00:00Z'), seen: false, allUid: 11, inboxUid: 1, structure: plain,
      body: 'Shall we meet on Friday?',
    },
    {
      emailId: 'e2', threadId: '1790000000000000077', messageId: '<b@home.example>', subject: 'Re: Plans', from: me, to: [sam],
      date: new Date('2026-11-21T09:00:00Z'), seen: true, allUid: 12, structure: plain,
      body: 'Friday works.\n\nOn Thu, 20 Nov 2026, Sam Field <sam@one.example> wrote:\n> Shall we meet on Friday?',
    },
    {
      emailId: 'e3', threadId: '1790000000000000088', messageId: '<c@shop.example>', subject: 'Your order', from: { name: 'Shop', address: 'orders@shop.example' }, to: [me],
      date: new Date('2026-11-22T09:00:00Z'), seen: false, allUid: 13, inboxUid: 2,
      structure: { type: 'multipart/mixed', childNodes: [
        { part: '1', ...htmlOnly },
        { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'invoice.pdf' }, size: 40_960 },
      ] },
      body: '<html><style>p{color:red}</style><body><p>Your order has <b>shipped</b>.</p><p>Total &amp; tax: 12&nbsp;EUR</p></body></html>',
    },
  ]
  return { messages, ...fakeServer({ gmail: true, messages }) }
}

const FORBIDDEN = /flag|store|expunge|delete|append|idle/i

describe('MailImapSource against a recording client', () => {
  it('lists the Inbox with Gmail thread ids and never sets a flag', async () => {
    const { client, calls } = gmailMailbox()
    const source = new MailImapSource({ account: 'You@Home.example', createClient: () => client })
    const inbox = await source.listInbox(200)
    expect(inbox.uidValidity).toBe('7')
    expect(inbox.messages.map((message) => [message.uid, message.threadId, message.seen])).toEqual([
      [1, '1790000000000000077', false],
      [2, '1790000000000000088', false],
    ])
    expect(inbox.messages[0]).toMatchObject({ gmailThreadId: '1790000000000000077', from: sam, subject: 'Plans' })
    expect(inbox.messages[0]!.receivedAt).toBe(inbox.messages[0]!.at + 3_600_000)
    expect(calls.map((call) => call.method)).toEqual(['connect', 'getMailboxLock', 'fetch', 'logout'])
  })

  it('reads a whole thread from all mail with peek-only downloads of the text part', async () => {
    const { client, calls, messages } = gmailMailbox()
    const source = new MailImapSource({ account: 'you@home.example', createClient: () => client })
    const thread = await source.readThread({ threadId: '1790000000000000077', gmailThreadId: '1790000000000000077', uidValidity: '7', uids: [1] })
    expect(thread.map((message) => [message.from.address, message.mine, message.text])).toEqual([
      ['sam@one.example', false, 'Shall we meet on Friday?'],
      // A later message loses its quoted history; the thread view already shows it.
      ['you@home.example', true, 'Friday works.'],
    ])
    expect(calls.map((call) => call.method)).toEqual(['connect', 'list', 'getMailboxLock', 'search', 'fetch', 'download', 'download', 'logout'])
    expect(calls.find((call) => call.method === 'getMailboxLock')?.args[0]).toBe('[Gmail]/All Mail')
    // imapflow fetches every body part with BODY.PEEK; nothing here asks for the raw source.
    for (const call of calls.filter((entry) => entry.method === 'fetch')) expect(call.args[1]).not.toHaveProperty('source')
    expect(calls.some((call) => FORBIDDEN.test(call.method))).toBe(false)
    expect(messages.map((message) => message.seen)).toEqual([false, true, false])
  })

  it('turns HTML-only mail into stripped plain text and lists attachments by name and size only', async () => {
    const { client, calls } = gmailMailbox()
    const source = new MailImapSource({ account: 'you@home.example', createClient: () => client })
    const [message] = await source.readThread({ threadId: '1790000000000000088', gmailThreadId: '1790000000000000088', uidValidity: '7', uids: [2] })
    expect(message?.text).toBe('Your order has shipped.\nTotal & tax: 12 EUR')
    expect(message?.text).not.toMatch(/[<>]|color/)
    expect(message?.attachments).toEqual([{ name: 'invoice.pdf', kb: 40 }])
    // Only the text node was downloaded, never the attachment's part.
    expect(calls.filter((call) => call.method === 'download').map((call) => call.args[1])).toEqual(['1'])
  })

  it('archives a Gmail thread by moving its Inbox messages to all mail, and restore copies them back', async () => {
    const { client, calls, messages } = gmailMailbox()
    const source = new MailImapSource({ account: 'you@home.example', createClient: () => client })
    const receipt = await source.archive({ threadId: '1790000000000000077', gmailThreadId: '1790000000000000077', uidValidity: '7', uids: [1] })
    expect(calls.filter((call) => call.method === 'messageMove').map((call) => call.args)).toEqual([['1', '[Gmail]/All Mail', { uid: true }]])
    expect((await source.listInbox(200)).messages.map((message) => message.threadId)).toEqual(['1790000000000000088'])

    calls.length = 0
    await source.restore(receipt)
    expect(calls.map((call) => call.method)).toEqual(['connect', 'list', 'getMailboxLock', 'search', 'messageCopy', 'logout'])
    expect(calls.find((call) => call.method === 'search')?.args[0]).toEqual({ emailId: 'e1' })
    expect(calls.find((call) => call.method === 'messageCopy')?.args).toEqual(['11', 'INBOX', { uid: true }])
    expect((await source.listInbox(200)).messages.map((message) => message.threadId)).toEqual(['1790000000000000088', '1790000000000000077'])
    expect(calls.some((call) => FORBIDDEN.test(call.method))).toBe(false)
    expect(messages[0]?.seen).toBe(false)
  })

  it('without Gmail, keys each message as its own thread and archives to the Archive folder and back', async () => {
    const messages: FakeMessage[] = [{
      emailId: '', threadId: '', messageId: '<x@one.example>', subject: 'Hello', from: sam, to: [me],
      date: new Date('2026-11-20T09:00:00Z'), seen: false, allUid: 0, inboxUid: 5, structure: plain, body: 'Hi there.',
    }]
    const { client, calls } = fakeServer({ gmail: false, messages })
    const source = new MailImapSource({ account: 'you@home.example', createClient: () => client })
    const inbox = await source.listInbox(200)
    expect(inbox.messages[0]).toMatchObject({ uid: 5, threadId: '7:5' })
    expect(inbox.messages[0]?.gmailThreadId).toBeUndefined()

    // The archived copy gets its uid in the Archive folder.
    messages[0]!.allUid = 9
    const receipt = await source.archive({ threadId: '7:5', uidValidity: '7', uids: [5] })
    expect(calls.filter((call) => call.method === 'messageMove').map((call) => call.args)).toEqual([['5', 'Archive', { uid: true }]])
    expect((await source.listInbox(200)).messages).toEqual([])
    await source.restore(receipt)
    expect(calls.find((call) => call.method === 'search')?.args[0]).toEqual({ header: { 'message-id': '<x@one.example>' } })
    expect(calls.filter((call) => call.method === 'messageMove').at(-1)?.args).toEqual(['9', 'INBOX', { uid: true }])
    expect((await source.listInbox(200)).messages.map((message) => message.subject)).toEqual(['Hello'])

    // Uids from an older numbering are refused rather than archived blindly.
    await expect(source.archive({ threadId: '6:5', uidValidity: '6', uids: [5] })).rejects.toThrow(/renumbered/)
  })
})

describe('MailImapSource edge cases', () => {
  it('refuses to archive on a server without MOVE, before any command that could expunge', async () => {
    const messages: FakeMessage[] = [{
      emailId: '', threadId: '', messageId: '<x@one.example>', subject: 'Hello', from: sam, to: [me],
      date: new Date('2026-11-20T09:00:00Z'), seen: false, allUid: 0, inboxUid: 5, structure: plain, body: 'Hi there.',
    }]
    const { client, calls } = fakeServer({ gmail: false, messages, move: false })
    const source = new MailImapSource({ account: 'you@home.example', createClient: () => client })
    await expect(source.archive({ threadId: '7:5', uidValidity: '7', uids: [5] })).rejects.toThrow(/MOVE/)
    expect(calls.map((call) => call.method)).toEqual(['connect', 'list', 'logout'])
  })

  it('does not read an attached mail as the message text, and lists it as one attachment', async () => {
    const messages: FakeMessage[] = [{
      emailId: 'e9', threadId: '1790000000000000099', messageId: '<f@one.example>', subject: 'Fwd: Plans', from: sam, to: [me],
      date: new Date('2026-11-20T09:00:00Z'), seen: false, allUid: 21, inboxUid: 9,
      structure: { type: 'multipart/mixed', childNodes: [
        { part: '1', ...htmlOnly },
        { part: '2', type: 'message/rfc822', disposition: 'attachment', dispositionParameters: { filename: 'plans.eml' }, size: 3_072, childNodes: [
          { part: '2.1', ...plain },
        ] },
      ] },
      body: '<p>See the attached mail.</p>',
    }]
    const { client, calls } = fakeServer({ gmail: true, messages })
    const source = new MailImapSource({ account: 'you@home.example', createClient: () => client })
    const [message] = await source.readThread({ threadId: '1790000000000000099', gmailThreadId: '1790000000000000099', uidValidity: '7', uids: [9] })
    expect(message?.text).toBe('See the attached mail.')
    expect(message?.attachments).toEqual([{ name: 'plans.eml', kb: 3 }])
    expect(calls.filter((call) => call.method === 'download').map((call) => call.args[1])).toEqual(['1'])
  })
})

describe('mailImapSourceFromEnv', () => {
  it('is undefined unless both mailbox keys are set', () => {
    expect(mailImapSourceFromEnv({})).toBeUndefined()
    expect(mailImapSourceFromEnv({ MANOR_MAIL_IMAP_USER: 'you@home.example' })).toBeUndefined()
    expect(mailImapSourceFromEnv({ MANOR_MAIL_IMAP_USER: 'You@Home.example', MANOR_MAIL_IMAP_PASSWORD: 'x' })?.account()).toBe('you@home.example')
  })
})
