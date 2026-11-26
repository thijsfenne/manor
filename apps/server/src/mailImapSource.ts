import { ImapFlow, type FetchMessageObject, type MessageAddressObject, type MessageStructureObject } from 'imapflow'
import {
  MAIL_MESSAGE_HTML_MAX,
  MAIL_MESSAGE_TEXT_MAX,
  MAIL_THREAD_HTML_MAX,
  MAIL_THREAD_MESSAGES_MAX,
  type MailAddress,
  type MailMessage,
} from '@manor/contracts'
import {
  attachments,
  decode,
  DEFAULT_MAIL_ENV_PREFIX,
  DEFAULT_MAILBOX,
  downloadCharset,
  htmlNode,
  htmlToText,
  mailEnvKeys,
  mailOptionalEnvKeys,
  openMailbox,
  readStream,
  stripQuotes,
  textNode,
} from './mcp/mailMcp.js'
import {
  normalAddress,
  singleMessageThreadId,
  type MailArchiveReceipt,
  type MailEnvelope,
  type MailInbox,
  type MailSource,
  type MailThreadRef,
} from './mailSource.js'

/**
 * The part of imapflow this source uses. A test hands in a recording fake with this
 * shape and asserts the exact commands; there is deliberately no flag-setting method
 * here, so this source cannot mark mail read even by mistake. imapflow itself fetches
 * every body part with BODY.PEEK.
 */
export type MailImapClient = Pick<
  ImapFlow,
  'connect' | 'logout' | 'list' | 'getMailboxLock' | 'search' | 'fetch' | 'download' | 'messageMove' | 'messageCopy'
> & {
  readonly mailbox: ImapFlow['mailbox']
  readonly capabilities: ImapFlow['capabilities']
}

interface MailImapSourceOptions {
  /** The login, which is the mailbox's own address. */
  account: string
  /** One fresh client per operation; the source connects and logs out around each. */
  createClient: () => MailImapClient
}

/** What `archive` hands `restore`: where the mail went and how to find it again. */
type Receipt =
  | { kind: 'gmail'; emailIds: string[] }
  | { kind: 'folder'; path: string; messageIds: string[] }

const INBOX = 'INBOX'
/** One character over the cap is enough to know a mail was cut; four bytes per character covers multibyte text. */
const TEXT_BYTES = MAIL_MESSAGE_TEXT_MAX * 4 + 64
/** Room for the largest HTML part a message may carry, plus one character to know it was over. */
const HTML_BYTES = MAIL_MESSAGE_HTML_MAX * 4 + 64

const address = (entry: MessageAddressObject | undefined): MailAddress => ({
  name: (entry?.name ?? '').slice(0, 400),
  address: (entry?.address ?? '').slice(0, 400),
})
const addresses = (list: readonly MessageAddressObject[] | undefined) =>
  (list ?? []).filter((entry) => (entry.address ?? '') !== '').slice(0, 100).map(address)

/** Gmail's extension is what gives threads and stable message ids across folders. */
const isGmail = (client: MailImapClient) => client.capabilities.has('X-GM-EXT-1')

/**
 * Without the MOVE extension imapflow emulates a move with COPY, a `\Deleted` flag and
 * EXPUNGE, and that EXPUNGE also removes anything another client had marked deleted. So
 * a server without MOVE gets no archive from here at all.
 */
function requireMove(client: MailImapClient) {
  if (!client.capabilities.has('MOVE')) throw new Error('This mail server cannot move mail safely (no IMAP MOVE), so Manor does not archive here.')
}

/** The first id that is not empty; a server may hand back an empty or blank one. */
const firstId = (...ids: (string | undefined)[]) => ids.map((id) => id?.trim() ?? '').find((id) => id !== '')

/**
 * An attached mail (`message/rfc822`) as a leaf: its own text part is not this
 * message's text, and its parts are not this message's attachments. It is listed as
 * one attachment instead.
 */
function withoutAttachedMessages(node: MessageStructureObject | undefined): MessageStructureObject | undefined {
  if (node === undefined) return undefined
  if (String(node.type ?? '').toLowerCase() === 'message/rfc822') {
    const { childNodes: _parts, ...leaf } = node
    return { ...leaf, disposition: 'attachment' }
  }
  return Array.isArray(node.childNodes) ? { ...node, childNodes: node.childNodes.map((child) => withoutAttachedMessages(child)!) } : node
}

const timeOf = (date: Date | string | undefined) => {
  const time = date instanceof Date ? date.getTime() : typeof date === 'string' ? Date.parse(date) : Number.NaN
  return Number.isFinite(time) ? time : undefined
}

const messageTime = (message: FetchMessageObject) => timeOf(message.envelope?.date ?? message.internalDate) ?? 0

const uidList = (found: number[] | false) => (Array.isArray(found) ? [...found].sort((left, right) => left - right) : [])

/**
 * The real mailbox, over IMAP with the connector's app password. Reads headers, the
 * text part and the HTML part only, never attachment bytes, and never sets a flag.
 * Archive is a move out of the Inbox and its Undo the way back.
 */
export class MailImapSource implements MailSource {
  constructor(private readonly options: MailImapSourceOptions) {}

  account(): string {
    return normalAddress(this.options.account)
  }

  private async withClient<T>(run: (client: MailImapClient) => Promise<T>): Promise<T> {
    const client = this.options.createClient()
    await client.connect()
    try {
      return await run(client)
    } finally {
      await client.logout().catch(() => undefined)
    }
  }

  /** The Inbox under the lock, with its UIDVALIDITY; refuses uids from an older numbering. */
  private async withInbox<T>(client: MailImapClient, run: (uidValidity: string) => Promise<T>, expected?: string): Promise<T> {
    const lock = await client.getMailboxLock(INBOX)
    try {
      const box = client.mailbox
      if (box === false) throw new Error('The Inbox did not open.')
      const uidValidity = String(box.uidValidity)
      if (expected !== undefined && expected !== uidValidity) {
        throw new Error('The Inbox was renumbered since the last refresh. Refresh and try again.')
      }
      return await run(uidValidity)
    } finally {
      lock.release()
    }
  }

  listInbox(limit: number): Promise<MailInbox> {
    return this.withClient((client) => this.withInbox(client, async (uidValidity) => {
      const box = client.mailbox
      const exists = box === false ? 0 : box.exists
      if (exists === 0) return { uidValidity, messages: [] }
      const gmail = isGmail(client)
      const messages: MailEnvelope[] = []
      // By sequence number: the newest `limit` messages are the last ones, with no SEARCH needed.
      for await (const message of client.fetch(
        `${Math.max(1, exists - limit + 1)}:*`,
        { uid: true, envelope: true, flags: true, internalDate: true, ...(gmail ? { threadId: true } : {}) },
      )) {
        const envelope = message.envelope
        const gmailThreadId = gmail ? message.threadId : undefined
        const receivedAt = timeOf(message.internalDate)
        messages.push({
          uid: message.uid,
          threadId: gmailThreadId ?? singleMessageThreadId(uidValidity, message.uid),
          ...(gmailThreadId === undefined ? {} : { gmailThreadId }),
          ...(envelope?.messageId === undefined ? {} : { messageId: envelope.messageId }),
          subject: envelope?.subject ?? '(no subject)',
          from: address(envelope?.from?.[0]),
          to: addresses(envelope?.to),
          cc: addresses(envelope?.cc),
          at: messageTime(message),
          ...(receivedAt === undefined ? {} : { receivedAt }),
          seen: message.flags?.has('\\Seen') ?? false,
        })
      }
      return { uidValidity, messages: messages.sort((left, right) => left.uid - right.uid).slice(-limit) }
    }))
  }

  readThread(thread: MailThreadRef): Promise<MailMessage[]> {
    return this.withClient(async (client) => {
      // A Gmail thread is read from all mail, so the account's own sent replies come along.
      if (isGmail(client) && thread.gmailThreadId !== undefined) {
        const opened = await openMailbox(client, DEFAULT_MAILBOX)
        try {
          const uids = uidList(await client.search({ threadId: thread.gmailThreadId }, { uid: true }))
          return await this.readMessages(client, uids.slice(-MAIL_THREAD_MESSAGES_MAX))
        } finally {
          opened.release()
        }
      }
      return this.withInbox(client, () => this.readMessages(client, thread.uids.slice(-MAIL_THREAD_MESSAGES_MAX)), thread.uidValidity)
    })
  }

  private async readMessages(client: MailImapClient, uids: readonly number[]): Promise<MailMessage[]> {
    if (uids.length === 0) throw new Error('This thread is no longer in the mailbox.')
    // Drained before any download: one connection runs one command at a time, and a
    // download issued while the fetch stream is open waits on it forever.
    const fetched: FetchMessageObject[] = []
    for await (const message of client.fetch(uids.join(','), { uid: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true })) {
      fetched.push(message)
    }
    fetched.sort((left, right) => messageTime(left) - messageTime(right) || left.uid - right.uid)
    const account = this.account()
    /** One part as a string; `whole` is false when the byte limit cut it short. */
    const readPart = async (uid: number, part: string, limit: number) => {
      const download = await client.download(String(uid), part, { uid: true })
      const bytes = await readStream(download.content, limit)
      return { raw: decode(bytes, downloadCharset(download)), whole: bytes.length < limit }
    }
    const messages: MailMessage[] = []
    for (const [index, message] of fetched.entries()) {
      const structure = withoutAttachedMessages(message.bodyStructure as MessageStructureObject | undefined)
      const node = textNode(structure)
      const htmlPart = htmlNode(structure)
      let text = ''
      let cut = false
      let htmlRead: { raw: string; whole: boolean } | undefined
      if (node !== undefined) {
        const read = await readPart(message.uid, node.part, node.type === 'text/html' ? HTML_BYTES : TEXT_BYTES)
        // A mail whose only text is HTML is downloaded once, for its text and its HTML.
        if (node.type === 'text/html') htmlRead = read
        cut = !read.whole
        text = node.type === 'text/html' ? htmlToText(read.raw) : read.raw
        // The thread view already shows the earlier messages, so each later one loses its
        // quoted history. The oldest keeps everything: nothing above it carries that text.
        text = index === 0 ? text.replace(/\r\n/g, '\n').trim() : stripQuotes(text)
      }
      // The text is already here, so an HTML part that will not download costs only the look.
      if (htmlPart !== undefined && htmlRead === undefined) htmlRead = await readPart(message.uid, htmlPart.part, HTML_BYTES).catch(() => undefined)
      // Cut HTML is broken markup, so a part the limit cut or over the cap is left out whole.
      const html = htmlRead?.whole === true && htmlRead.raw.length <= MAIL_MESSAGE_HTML_MAX ? htmlRead.raw : undefined
      const from = address(message.envelope?.from?.[0])
      const truncated = cut || text.length > MAIL_MESSAGE_TEXT_MAX
      messages.push({
        id: (firstId(message.emailId, message.envelope?.messageId) ?? String(message.uid)).slice(0, 200),
        from,
        to: addresses(message.envelope?.to),
        cc: addresses(message.envelope?.cc),
        at: messageTime(message),
        text: text.slice(0, MAIL_MESSAGE_TEXT_MAX),
        ...(html === undefined ? {} : { html }),
        truncated,
        attachments: attachments(structure).slice(0, 50).map((entry) => ({ name: entry.name.slice(0, 400), kb: entry.kb })),
        mine: normalAddress(from.address) === account,
      })
    }
    // The thread's HTML budget goes to the newest messages; an older one over it shows its text.
    let htmlLeft = MAIL_THREAD_HTML_MAX
    for (const message of [...messages].reverse()) {
      if (message.html === undefined) continue
      if (message.html.length <= htmlLeft) htmlLeft -= message.html.length
      else delete message.html
    }
    return messages
  }

  archive(thread: MailThreadRef): Promise<MailArchiveReceipt> {
    return this.withClient(async (client) => {
      const mailboxes = await client.list()
      const allMail = mailboxes.find((entry) => entry.specialUse === '\\All')?.path
      const archiveFolder = mailboxes.find((entry) => entry.specialUse === '\\Archive')?.path
      const gmail = isGmail(client) && allMail !== undefined
      if (!gmail && archiveFolder === undefined) {
        throw new Error('This mailbox has no archive folder over IMAP, so Manor cannot archive here.')
      }
      requireMove(client)
      // Gmail finds the thread's Inbox messages itself, so a stale cached uid cannot miss one.
      return this.withInbox(client, async () => {
        const uids = gmail && thread.gmailThreadId !== undefined
          ? uidList(await client.search({ threadId: thread.gmailThreadId }, { uid: true }))
          : thread.uids
        if (uids.length === 0) throw new Error('This thread is no longer in the Inbox.')
        const ids: string[] = []
        for await (const message of client.fetch(uids.join(','), { uid: true, envelope: true }, { uid: true })) {
          const id = firstId(gmail ? message.emailId : message.envelope?.messageId)
          if (id !== undefined) ids.push(id)
        }
        // Without a way to find the mail again there is no Undo, so nothing moves.
        if (ids.length < uids.length) throw new Error('This thread cannot be archived with Undo: a message has no id to find it by.')
        const target = gmail ? allMail : archiveFolder!
        // In Gmail, moving out of the Inbox into all mail is exactly removing the Inbox label.
        const moved = await client.messageMove(uids.join(','), target, { uid: true })
        if (moved === false) throw new Error('The mail server refused to archive this thread.')
        const receipt: Receipt = gmail ? { kind: 'gmail', emailIds: ids } : { kind: 'folder', path: target, messageIds: ids }
        return JSON.stringify(receipt)
      }, gmail ? undefined : thread.uidValidity)
    })
  }

  restore(receipt: MailArchiveReceipt): Promise<void> {
    const parsed = JSON.parse(receipt) as Receipt
    return this.withClient(async (client) => {
      const opened = parsed.kind === 'gmail'
        ? await openMailbox(client, DEFAULT_MAILBOX)
        : await openMailbox(client, parsed.path)
      try {
        const uids: number[] = []
        const ids = parsed.kind === 'gmail' ? parsed.emailIds : parsed.messageIds
        for (const id of ids) {
          const query = parsed.kind === 'gmail' ? { emailId: id } : { header: { 'message-id': id } }
          // One message per id: two deliveries can share a Message-ID, and Undo moves back only what Archive moved.
          const found = uidList(await client.search(query, { uid: true })).at(-1)
          if (found !== undefined) uids.push(found)
        }
        // A message deleted since the archive cannot come back; the rest still does.
        if (uids.length === 0) throw new Error('The archived mail could not be found again.')
        if (parsed.kind === 'folder') requireMove(client)
        // Gmail keeps one message under many labels, so a copy into the Inbox adds the
        // label back. A plain archive folder holds the message itself, so it moves back.
        const done = parsed.kind === 'gmail'
          ? await client.messageCopy(uids.join(','), INBOX, { uid: true })
          : await client.messageMove(uids.join(','), INBOX, { uid: true })
        if (done === false) throw new Error('The mail server refused to put this thread back in the Inbox.')
      } finally {
        opened.release()
      }
    })
  }
}

/**
 * The IMAP source for the connector's own mailbox keys, or undefined when either key is
 * missing and the Mail door stays off. Host and port default to Gmail.
 */
export function mailImapSourceFromEnv(env: NodeJS.ProcessEnv = process.env, prefix = DEFAULT_MAIL_ENV_PREFIX): MailImapSource | undefined {
  const [userKey = '', passwordKey = ''] = mailEnvKeys(prefix)
  const [hostKey = '', portKey = ''] = mailOptionalEnvKeys(prefix)
  const user = env[userKey]?.trim() ?? ''
  const pass = env[passwordKey] ?? ''
  if (user === '' || pass === '') return undefined
  return new MailImapSource({
    account: user,
    createClient: () => {
      const client = new ImapFlow({
        host: env[hostKey]?.trim() || 'imap.gmail.com',
        port: Number(env[portKey]?.trim() || '993'),
        secure: true,
        auth: { user, pass },
        logger: false,
      })
      // A dropped socket is reported through the command that was waiting on it; an
      // unheard 'error' event would instead take the whole server down.
      client.on('error', () => undefined)
      return client
    },
  })
}
