import { createInterface } from 'node:readline'
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from 'imapflow'
import type { OutboundThreadMessage } from '@manor/contracts'

/**
 * Manor's own mail connector, spoken over stdio MCP like any registry server.
 *
 * It exists because the general-purpose Gmail MCP was wrong on all three axes that
 * matter here. Its OAuth app is unverified, so Google expires the refresh token every
 * seven days and a persona silently loses its tools mid-errand. Its `get_message`
 * always returns the whole MIME tree, so one mail about picture frames was 4,4 MB of
 * base64 that no persona can afford to read. And it advertises 64 tools, every schema
 * of which is injected per persona per turn, to serve three verbs: search, read,
 * draft.
 *
 * IMAP with an app password fixes the first (app passwords do not expire), selective
 * part fetching fixes the second (only the text/plain node is ever downloaded), and
 * the tool list below fixes the third.
 *
 * Deliberately no send tool. This connector can only put a draft in the mail client.
 * The transcript bubble is the separate human confirmation surface for sending: an
 * agent cannot reach that path or smuggle a `confirmed: true` argument into this MCP.
 */

/**
 * The mailbox is selected by an env-var prefix rather than an account argument, so a
 * non-Gmail account can live under its own keys; one process speaks one IMAP login. `--env-prefix=MANOR_MAIL_OTHER` makes this process read
 * `MANOR_MAIL_OTHER_IMAP_USER` / `_PASSWORD`. Absent, it is the personal mailbox.
 */
export const DEFAULT_MAIL_ENV_PREFIX = 'MANOR_MAIL'

export function mailEnvPrefix(argv: readonly string[] = process.argv): string {
  const flag = argv.find((argument) => argument.startsWith('--env-prefix='))
  if (flag === undefined) return DEFAULT_MAIL_ENV_PREFIX
  const value = flag.slice('--env-prefix='.length).trim()
  if (!/^[A-Z][A-Z0-9_]{0,48}$/.test(value)) {
    throw new Error('mail --env-prefix must be an uppercase environment prefix such as MANOR_MAIL_OTHER.')
  }
  return value
}

export function mailEnvKeys(prefix: string = DEFAULT_MAIL_ENV_PREFIX): string[] {
  return [`${prefix}_IMAP_USER`, `${prefix}_IMAP_PASSWORD`]
}

/**
 * Host and port stay out of the registry row on purpose: the probe treats a listed
 * key with no value as a hard error, which is right for a credential and wrong for a
 * setting that has a working default. A non-Gmail account adds them to the row by hand.
 */
export function mailOptionalEnvKeys(prefix: string = DEFAULT_MAIL_ENV_PREFIX): string[] {
  return [`${prefix}_IMAP_HOST`, `${prefix}_IMAP_PORT`]
}

const prefix = mailEnvPrefix()
const USER_ENV = `${prefix}_IMAP_USER`

/**
 * Not a path but a request for one. Everything filed or archived minus spam and trash
 * is the right default for "what did she send me", which is the question this gets
 * asked, and the inbox is the wrong answer to it. The actual folder is resolved per
 * connection, because its name is localised: this account calls it
 * `[Gmail]/Alle e-mail`, so any hard-coded English path is a mailbox that does not
 * exist and an IMAP `NO` that reads only as "Command failed".
 */
const DEFAULT_MAILBOX = 'ALL'

const SEARCH_LIMIT_DEFAULT = 20
const SEARCH_LIMIT_MAX = 50
/** Enough to judge a mail, short enough that a bad hit costs almost nothing. */
const SNIPPET_CHARS = 220
const SNIPPET_BYTES = 4_000
const READ_LIMIT_MAX = 15
const BODY_CHARS_MAX = 6_000

function accountLabel(): string {
  const user = process.env[USER_ENV]
  return user !== undefined && user !== '' ? user : 'this mailbox'
}

function tools() {
  const account = accountLabel()
  return [
    {
      name: 'mail_search',
      description:
        `Search ${account} and return one line per hit: uid, date, sender, subject, unread flag and a short snippet. ` +
        'Never returns message bodies, so it is cheap enough to search broadly. ' +
        'The query uses Gmail search syntax, for example "from:sam@example.com newer_than:30d" or "has:attachment invoice". ' +
        'Pass the uid values you care about to mail_read on this same server; uids are not valid on another mailbox.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A Gmail search expression.' },
          limit: { type: 'number', description: `Maximum hits, newest first. Default ${SEARCH_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX}.` },
          mailbox: { type: 'string', description: 'Mailbox to search. Defaults to all mail; pass "INBOX" to narrow.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'mail_read',
      description:
        `Read the plain text of messages in ${account} by uid, with quoted reply trailers and signatures removed. ` +
        'Only the text part is downloaded, never HTML or attachments. Ask for the few uids you actually need. ' +
        'Each Gmail message includes a thread object; pass it unchanged to prepare_outbound_draft when replying, ' +
        'so Later, Ignore and thread context work across routine runs. ' +
        'Attachments come back as names and sizes only: an empty body with an attachment listed means the sender ' +
        'wrote nothing and sent a file, so report the file rather than reporting nothing.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          uids: { type: 'array', items: { type: 'number' }, description: `Message uids from mail_search, at most ${READ_LIMIT_MAX}.` },
          mailbox: { type: 'string', description: 'The mailbox the uids came from. Must match the mail_search call.' },
        },
        required: ['uids'],
        additionalProperties: false,
      },
    },
    {
      name: 'mail_draft',
      description:
        `Save a plain-text draft in ${account}, for the user to review and send themselves. ` +
        'This tool cannot send mail. Pass replyToUid to make it a reply in an existing thread.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
          cc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain text. No HTML, no markdown formatting.' },
          replyToUid: { type: 'number', description: 'Uid of the message being replied to, from mail_search.' },
          mailbox: { type: 'string', description: 'The mailbox replyToUid came from.' },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
    },
  ]
}

function instructions(): string {
  return [
    `${accountLabel()}, over IMAP.`,
    'Search first and read only the uids that matter: mail_search is cheap, mail_read is not.',
    'mail_draft saves a draft for the user to send themselves; there is no way to send mail from here, so never claim a mail went out.',
    'This server is one mailbox. Another mail server, if attached, is a different account; do not mix uids across them.',
  ].join(' ')
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null

function required(key: string): string {
  const value = process.env[key]
  if (value === undefined || value === '') throw new Error(`${key} is not set in this server's environment.`)
  return value
}

async function withClient<T>(run: (client: ImapFlow) => Promise<T>): Promise<T> {
  return withClientForPrefix(prefix, run)
}

async function withClientForPrefix<T>(selectedPrefix: string, run: (client: ImapFlow) => Promise<T>): Promise<T> {
  const hostEnv = `${selectedPrefix}_IMAP_HOST`
  const portEnv = `${selectedPrefix}_IMAP_PORT`
  const userEnv = `${selectedPrefix}_IMAP_USER`
  const passwordEnv = `${selectedPrefix}_IMAP_PASSWORD`
  const client = new ImapFlow({
    host: process.env[hostEnv] ?? 'imap.gmail.com',
    port: Number(process.env[portEnv] ?? '993'),
    secure: true,
    auth: { user: required(userEnv), pass: required(passwordEnv) },
    // The provider CLI shares stdout with the MCP framing, so the client must never
    // print. A stray log line here is an unparseable JSON-RPC message, not noise.
    logger: false,
  })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.logout().catch(() => undefined)
  }
}

/**
 * The one node worth downloading. Walks the structure the server already sent with
 * the envelope and picks text/plain, falling back to text/html only when a sender
 * shipped no plain alternative. Attachments and inline images are never candidates,
 * which is the whole reason this connector is affordable.
 */
function textNode(structure: MessageStructureObject | undefined): { part: string; type: string } | undefined {
  if (structure === undefined) return undefined
  const candidates: { part: string; type: string }[] = []
  const walk = (node: MessageStructureObject) => {
    const children = node.childNodes
    if (Array.isArray(children) && children.length > 0) {
      for (const child of children) walk(child)
      return
    }
    const type = String(node.type ?? '')
    if (type !== 'text/plain' && type !== 'text/html') return
    const disposition = String(node.disposition ?? '')
    if (disposition === 'attachment') return
    // The declared charset is deliberately not carried out of here. It is the charset
    // of the bytes on the server, not of the bytes `download` hands back, and reading
    // it as if it were the latter is exactly the double-decode `downloadCharset`
    // exists to prevent. Leaving it available would invite that mistake again.
    candidates.push({
      // A single-part message has no part number; IMAP addresses its body as 1.
      part: typeof node.part === 'string' && node.part.length > 0 ? node.part : '1',
      type,
    })
  }
  walk(structure)
  return candidates.find((candidate) => candidate.type === 'text/plain') ?? candidates[0]
}

export interface AttachmentSummary {
  name: string
  type: string
  kb: number
}

/**
 * Names and sizes of what is attached, never the bytes.
 *
 * This exists because of a mail that read as empty and was not. A reply carrying only
 * `afmetingen posters.docx` has no text above the quoted trailer, so the body is
 * genuinely blank and the connector was reporting "she sent nothing" about the one
 * mail whose content was the point. A filename costs a few dozen characters and is
 * usually enough to know whether the attachment needs opening at all.
 */
export function attachments(structure: MessageStructureObject | undefined): AttachmentSummary[] {
  if (structure === undefined) return []
  const found: AttachmentSummary[] = []
  const walk = (node: MessageStructureObject) => {
    const children = node.childNodes
    if (Array.isArray(children) && children.length > 0) {
      for (const child of children) walk(child)
      return
    }
    const type = String(node.type ?? '')
    const disposition = String(node.disposition ?? '')
    const parameters = isRecord(node.dispositionParameters) ? node.dispositionParameters : {}
    const typeParameters = isRecord(node.parameters) ? node.parameters : {}
    const name =
      (typeof parameters['filename'] === 'string' ? parameters['filename'] : undefined) ??
      (typeof typeParameters['name'] === 'string' ? typeParameters['name'] : undefined)
    // Inline images with no filename are signature furniture, not content.
    if (disposition !== 'attachment' && name === undefined) return
    if (type === 'text/plain' || type === 'text/html') {
      if (disposition !== 'attachment') return
    }
    found.push({
      name: name ?? '(unnamed)',
      type,
      kb: Math.round(Number(node.size ?? 0) / 1024),
    })
  }
  walk(structure)
  return found
}

async function readStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    chunks.push(buffer)
    size += buffer.length
    // Stop paying for a 4 MB mail the moment enough of it has arrived. Destroying the
    // stream ends the IMAP literal early rather than reading it into memory to discard.
    if (size >= maxBytes) {
      const destroy = (stream as unknown as { destroy?: () => void }).destroy
      if (typeof destroy === 'function') destroy.call(stream)
      break
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes)
}

/**
 * The charset the bytes are actually in by the time they reach us, which is not the
 * one the message declared.
 *
 * `download` transcodes any non-ASCII, non-UTF-8 part through a streaming decoder and
 * rewrites `meta.charset` to `utf-8` on the way out, so decoding the result with the
 * charset from `bodyStructure` decodes it twice: a Latin-1 mail arrives as correct
 * UTF-8 bytes and gets read back as Latin-1, turning `café` into `cafÃ©`. Reading
 * `meta` rather than assuming UTF-8 also covers the one case where imapflow gives up,
 * a charset its decoder does not know, which it passes through untouched and leaves
 * labelled with the original name.
 */
const downloadCharset = (download: { meta?: { charset?: string } }): string =>
  download.meta?.charset ?? 'utf-8'

function decode(buffer: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

const HTML_TAG = /<[^>]*>/g

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(HTML_TAG, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
}

/**
 * Quoted history is the bulk of most replies and the model already has it, either
 * from an earlier message in the same thread or not at all. Cut at the first
 * separator rather than filtering '>' lines, because the header line above the quote
 * ("Op ... schreef ...") is not itself quoted.
 */
const QUOTE_MARKERS = [
  /^>/,
  /^-{2,}\s*(original message|forwarded message|oorspronkelijk bericht)/i,
  /^_{10,}$/,
  /^-{10,}$/,
  // "On Mon 11 Aug …, Someone <a@b.nl> wrote:" and "Op 13 aug … schreef Robin:".
  // The sender's name may follow the verb, so the anchor is the line end, not the verb.
  /^(on|op)\b.{0,200}\b(wrote|schreef|verzonden)\b[^\n]{0,80}:?\s*$/i,
  /^(from|van|van:)\s*:?\s*.+<.+@.+>/i,
  /^sent from my /i,
  /^verstuurd vanaf mijn /i,
]

function stripQuotes(text: string): string {
  const lines = text.split(/\r?\n/)
  const cut = lines.findIndex((line) => QUOTE_MARKERS.some((marker) => marker.test(line.trim())))
  const kept = cut === -1 ? lines : lines.slice(0, cut)
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const addressList = (list: readonly { name?: string; address?: string }[] | undefined): string =>
  (list ?? [])
    .map((entry) => {
      const address = entry.address ?? ''
      const name = entry.name ?? ''
      return name === '' ? address : `${name} <${address}>`
    })
    .filter((entry) => entry.length > 0)
    .join(', ')

/**
 * Turns whatever the caller asked for into a path this account actually has, and opens
 * it. Special-use flags are the only stable way to name Gmail's own folders, and a
 * mistyped path gets the list back rather than the server's bare `NO`, so the model can
 * correct itself instead of reporting a dead end.
 */
async function openMailbox(client: ImapFlow, requested: string): Promise<{ path: string; release: () => void }> {
  const mailboxes = await client.list()
  const path =
    requested === DEFAULT_MAILBOX
      ? mailboxes.find((entry) => entry.specialUse === '\\All')?.path ?? 'INBOX'
      : requested
  try {
    const lock = await client.getMailboxLock(path)
    return { path, release: () => lock.release() }
  } catch (error: unknown) {
    const known = mailboxes.map((entry) => entry.path).join(', ')
    throw new Error(
      `Cannot open mailbox "${path}" (${error instanceof Error ? error.message : 'failed'}). ` +
        `This account has: ${known}.`,
    )
  }
}

interface SearchHit {
  uid: number
  date: string
  from: string
  subject: string
  unread: boolean
  snippet: string
  threadId?: string
}

async function search(query: string, limit: number, mailbox: string): Promise<{ mailbox: string; hits: SearchHit[] }> {
  return withClient(async (client) => {
    const opened = await openMailbox(client, mailbox)
    try {
      // Gmail's own search grammar, handed over untouched. Translating it into IMAP
      // SEARCH terms here would be a worse search engine reimplemented badly.
      const uids = await client.search({ gmraw: query } as never, { uid: true })
      if (!Array.isArray(uids) || uids.length === 0) return { mailbox: opened.path, hits: [] }
      const newest = uids.slice(-limit).reverse()
      const hits: SearchHit[] = []
      const messages = new Map<number, FetchMessageObject>()
      for await (const message of client.fetch(
        newest.join(','),
        { uid: true, envelope: true, flags: true, bodyStructure: true, threadId: true },
        { uid: true },
      )) {
        messages.set(message.uid, message)
      }
      for (const uid of newest) {
        const message = messages.get(uid)
        if (message === undefined) continue
        const envelope = message.envelope
        const node = textNode(message.bodyStructure as MessageStructureObject | undefined)
        let snippet = ''
        if (node !== undefined) {
          try {
            const download = await client.download(String(uid), node.part, { uid: true })
            const raw = decode(await readStream(download.content, SNIPPET_BYTES), downloadCharset(download))
            const text = node.type === 'text/html' ? htmlToText(raw) : raw
            snippet = collapse(stripQuotes(text)).slice(0, SNIPPET_CHARS)
          } catch {
            // A snippet is a convenience; a mail whose body will not fetch is still a
            // real hit and its envelope is the part that decides whether to open it.
            snippet = ''
          }
        }
        hits.push({
          uid,
          date: envelope?.date instanceof Date ? envelope.date.toISOString() : '',
          from: addressList(envelope?.from),
          subject: envelope?.subject ?? '(no subject)',
          unread: !(message.flags?.has('\\Seen') ?? false),
          snippet,
          ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
        })
      }
      return { mailbox: opened.path, hits }
    } finally {
      opened.release()
    }
  })
}

interface ReadMessage {
  uid: number
  date: string
  from: string
  to: string
  subject: string
  body: string
  truncated: boolean
  attachments: AttachmentSummary[]
  thread?: {
    threadId: string
    previous: { from: string; at: string; text: string }
    earlierCount: number
    openUrl?: string
  }
}

export function gmailThreadUrl(threadId: string, account: string): string | undefined {
  try {
    const hex = BigInt(threadId).toString(16)
    return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#all/${hex}`
  } catch {
    return undefined
  }
}

/**
 * Gmail names one thread two ways. IMAP's X-GM-THRID is decimal, the Gmail API's id is
 * the same number in hex (`1a11577524273408`), and a card carries whichever the
 * reading connector returned. Undefined means the value cannot be a Gmail thread.
 */
export function gmailThreadIdForImap(threadId: string): string | undefined {
  const id = threadId.trim()
  if (/^[0-9a-f]{1,16}$/i.test(id)) return BigInt(`0x${id}`).toString()
  if (/^\d{17,20}$/.test(id)) return id
  return undefined
}

export interface MailReplyHeaders {
  inReplyTo: string
  references: string[]
}

const MESSAGE_ID_TOKEN = /<[^<>\s@]+@[^<>\s@]+>/g
const REFERENCES_MAX = 20

/**
 * Threading headers for a reply to one message, from its Message-ID and raw header
 * block. Both are chosen by the original sender, so only well-formed `<id@host>`
 * tokens survive; anything else could smuggle a header line into the reply.
 */
export function replyHeadersFor(messageId: string | undefined, rawHeaders: string): MailReplyHeaders | undefined {
  const parent = messageId?.match(MESSAGE_ID_TOKEN)?.[0]
  if (parent === undefined) return undefined
  // Unfold first: a long References header continues on indented lines.
  const header = /^references:[ \t]*(.*)$/im.exec(rawHeaders.replace(/\r?\n[ \t]+/g, ' '))?.[1] ?? ''
  const chain = [...new Set([...(header.match(MESSAGE_ID_TOKEN) ?? []).filter((id) => id !== parent), parent])]
  // RFC 5322 lets a long chain drop its middle; the root and the newest ids carry the thread.
  const references = chain.length > REFERENCES_MAX ? [chain[0]!, ...chain.slice(-(REFERENCES_MAX - 1))] : chain
  return { inReplyTo: parent, references }
}

/**
 * The In-Reply-To and References a confirmed Submit needs so Gmail files the reply in
 * the card's thread. Replies to the newest message in the thread, as Gmail itself does.
 */
export async function readMailReplyHeaders(threadId: string): Promise<MailReplyHeaders> {
  const imapThreadId = gmailThreadIdForImap(threadId)
  if (imapThreadId === undefined) throw new Error('the draft does not carry a Gmail thread id')
  return withClientForPrefix(DEFAULT_MAIL_ENV_PREFIX, async (client) => {
    const opened = await openMailbox(client, DEFAULT_MAILBOX)
    try {
      const found = await client.search({ threadId: imapThreadId }, { uid: true })
      const uids = Array.isArray(found) ? found.slice(-THREAD_MESSAGE_LIMIT) : []
      if (uids.length === 0) throw new Error('the original email thread is no longer in the mailbox')
      let newest: { at: number; uid: number; headers: MailReplyHeaders } | undefined
      for await (const message of client.fetch(
        uids.join(','),
        { uid: true, envelope: true, headers: ['references'] },
        { uid: true },
      )) {
        const headers = replyHeadersFor(message.envelope?.messageId, message.headers?.toString('utf8') ?? '')
        if (headers === undefined) continue
        const at = message.envelope?.date instanceof Date ? message.envelope.date.getTime() : 0
        if (newest === undefined || at > newest.at || (at === newest.at && message.uid > newest.uid)) {
          newest = { at, uid: message.uid, headers }
        }
      }
      if (newest === undefined) throw new Error('no message in the original thread has a usable Message-ID')
      return newest.headers
    } finally {
      opened.release()
    }
  })
}

async function read(uids: readonly number[], mailbox: string): Promise<{ mailbox: string; messages: ReadMessage[] }> {
  return withClient(async (client) => {
    const opened = await openMailbox(client, mailbox)
    try {
      // Drained before a single download starts, and that ordering is load-bearing.
      // One IMAP connection runs one command at a time, so a `download` issued while
      // the `fetch` stream is still open waits for a stream that is itself waiting for
      // its consumer, and the read hangs with no error to show for it.
      const fetched: FetchMessageObject[] = []
      for await (const message of client.fetch(
        uids.join(','),
        { uid: true, envelope: true, bodyStructure: true, threadId: true },
        { uid: true },
      )) {
        fetched.push(message)
      }

      const out: ReadMessage[] = []
      for (const message of fetched) {
        const envelope = message.envelope
        const node = textNode(message.bodyStructure as MessageStructureObject | undefined)
        let body = ''
        if (node !== undefined) {
          const download = await client.download(String(message.uid), node.part, { uid: true })
          // One character over the cap is enough to know the mail was cut; ask for
          // four bytes per character so multibyte text is not truncated early.
          const raw = decode(await readStream(download.content, BODY_CHARS_MAX * 4 + 64), downloadCharset(download))
          body = stripQuotes(node.type === 'text/html' ? htmlToText(raw) : raw)
        }
        const truncated = body.length > BODY_CHARS_MAX
        const date = envelope?.date instanceof Date ? envelope.date.toISOString() : ''
        const from = addressList(envelope?.from)
        let thread: ReadMessage['thread']
        if (message.threadId !== undefined && date !== '') {
          const matches = await client.search({ threadId: message.threadId }, { uid: true })
          const openUrl = gmailThreadUrl(message.threadId, required(USER_ENV))
          thread = {
            threadId: message.threadId,
            previous: { from, at: date, text: truncated ? body.slice(0, BODY_CHARS_MAX) : body },
            earlierCount: Math.max(0, (Array.isArray(matches) ? matches.length : 1) - 1),
            ...(openUrl === undefined ? {} : { openUrl }),
          }
        }
        out.push({
          uid: message.uid,
          date,
          from,
          to: addressList(envelope?.to),
          subject: envelope?.subject ?? '(no subject)',
          body: truncated ? `${body.slice(0, BODY_CHARS_MAX)}\n[truncated]` : body,
          truncated,
          attachments: attachments(message.bodyStructure as MessageStructureObject | undefined),
          ...(thread === undefined ? {} : { thread }),
        })
      }
      return { mailbox: opened.path, messages: out }
    } finally {
      opened.release()
    }
  })
}

const THREAD_MESSAGE_LIMIT = 50
const OUTBOUND_THREAD_BODY_CHARS = 20_000

export async function readMailThread(
  threadId: string,
): Promise<{ messages: OutboundThreadMessage[]; truncated: boolean; openUrl?: string }> {
  const imapThreadId = gmailThreadIdForImap(threadId)
  if (imapThreadId === undefined) throw new Error('This draft does not carry a Gmail thread id.')
  return withClientForPrefix(DEFAULT_MAIL_ENV_PREFIX, async (client) => {
    const opened = await openMailbox(client, DEFAULT_MAILBOX)
    try {
      const found = await client.search({ threadId: imapThreadId }, { uid: true })
      const uids = Array.isArray(found) ? found : []
      const selected = uids.slice(-THREAD_MESSAGE_LIMIT)
      if (selected.length === 0) throw new Error('This email thread is no longer available in the mailbox.')
      const fetched: FetchMessageObject[] = []
      for await (const message of client.fetch(
        selected.join(','),
        { uid: true, envelope: true, bodyStructure: true },
        { uid: true },
      )) fetched.push(message)

      const messages: OutboundThreadMessage[] = []
      for (const message of fetched) {
        const envelope = message.envelope
        const at = envelope?.date instanceof Date ? envelope.date.toISOString() : undefined
        if (at === undefined) continue
        const node = textNode(message.bodyStructure as MessageStructureObject | undefined)
        let text = ''
        if (node !== undefined) {
          const download = await client.download(String(message.uid), node.part, { uid: true })
          const raw = decode(
            await readStream(download.content, OUTBOUND_THREAD_BODY_CHARS * 4 + 64),
            downloadCharset(download),
          )
          text = stripQuotes(node.type === 'text/html' ? htmlToText(raw) : raw).slice(0, OUTBOUND_THREAD_BODY_CHARS)
        }
        messages.push({
          id: message.emailId ?? String(message.uid),
          from: addressList(envelope?.from),
          ...(addressList(envelope?.to) === '' ? {} : { to: addressList(envelope?.to) }),
          at,
          ...(envelope?.subject === undefined ? {} : { subject: envelope.subject }),
          text,
        })
      }
      messages.sort((left, right) => left.at.localeCompare(right.at))
      const openUrl = gmailThreadUrl(imapThreadId, required(`${DEFAULT_MAIL_ENV_PREFIX}_IMAP_USER`))
      return {
        messages,
        truncated: uids.length > selected.length,
        ...(openUrl === undefined ? {} : { openUrl }),
      }
    } finally {
      opened.release()
    }
  })
}

/** RFC 2047 word, so a subject with an accent does not arrive as mojibake. */
const headerValue = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`

function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join('\r\n')
}

/**
 * One recipient, or a refusal.
 *
 * Headers are separated by CRLF, so an address carrying one is not an address, it is
 * extra headers. `alice@x.nl\r\nBcc: someone@else.nl` appended to a `To:` line adds a
 * recipient nobody in this chat agreed to, and the draft sitting in the Drafts folder
 * looks entirely normal until it is sent. The subject is already safe by accident,
 * `headerValue` base64-encodes anything outside printable ASCII and CR and LF are
 * outside it, but relying on that is relying on an accident.
 *
 * The shape check is deliberately loose. This is not an address validator, it is a
 * check that one header field holds one field's worth of text.
 */
function recipient(value: string): string {
  const address = value.trim()
  if (address.length === 0) throw new Error('An empty recipient is not an address.')
  if (/[\r\n]/.test(address)) {
    throw new Error(`"${address.replace(/[\r\n]+/g, ' ⏎ ')}" spans more than one line, so it is not one address.`)
  }
  if (!/^[^@<>\s]+@[^@<>\s]+\.[^@<>\s]+$/.test(address) && !/^[^<>]*<[^@<>\s]+@[^@<>\s]+\.[^@<>\s]+>$/.test(address)) {
    throw new Error(`"${address}" is not an email address; give it as name@example.com or Name <name@example.com>.`)
  }
  return address
}

interface DraftInput {
  to: readonly string[]
  cc?: readonly string[]
  subject: string
  body: string
  replyToUid?: number
  mailbox: string
}

async function draft(input: DraftInput): Promise<{ mailbox: string; subject: string }> {
  return withClient(async (client) => {
    let inReplyTo: string | undefined
    let references: string | undefined
    let subject = input.subject
    if (input.replyToUid !== undefined) {
      const opened = await openMailbox(client, input.mailbox)
      try {
        for await (const message of client.fetch(
          String(input.replyToUid),
          { uid: true, envelope: true, headers: ['references'] },
          { uid: true },
        )) {
          inReplyTo = message.envelope?.messageId
          const raw = message.headers?.toString('utf8') ?? ''
          const match = /^references:\s*([\s\S]*?)(?:\r?\n(?![ \t])|$)/im.exec(raw)
          const prior = match?.[1]?.replace(/\s+/g, ' ').trim()
          references = [prior, inReplyTo].filter((value) => value !== undefined && value !== '').join(' ')
          const original = message.envelope?.subject ?? ''
          if (original !== '' && !/^re:/i.test(original)) subject = `Re: ${original}`
          else if (original !== '') subject = original
        }
      } finally {
        opened.release()
      }
    }

    // Gmail localises its folder names, so the Dutch account has no [Gmail]/Drafts.
    // The special-use flag is the only stable way to name the drafts folder.
    const mailboxes = await client.list()
    const drafts = mailboxes.find((entry) => entry.specialUse === '\\Drafts')?.path
    if (drafts === undefined) throw new Error('This account exposes no drafts folder over IMAP.')

    const to = input.to.map(recipient)
    const cc = (input.cc ?? []).map(recipient)
    // Threading headers are not the model's input, they are the previous sender's, so
    // they get the same treatment. A Message-ID is chosen by whoever sent the mail
    // being replied to, which makes it attacker-controlled text on a header line.
    const singleLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()

    const headers = [
      `From: ${required(USER_ENV)}`,
      `To: ${to.join(', ')}`,
      ...(cc.length === 0 ? [] : [`Cc: ${cc.join(', ')}`]),
      `Subject: ${headerValue(subject)}`,
      ...(inReplyTo === undefined ? [] : [`In-Reply-To: ${singleLine(inReplyTo)}`]),
      ...(references === undefined || references === '' ? [] : [`References: ${singleLine(references)}`]),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ]
    const message = `${headers.join('\r\n')}\r\n\r\n${wrapBase64(Buffer.from(input.body, 'utf8').toString('base64'))}\r\n`
    await client.append(drafts, message, ['\\Draft'])
    return { mailbox: drafts, subject }
  })
}

async function call(name: string, arguments_: JsonRecord): Promise<unknown> {
  if (name === 'mail_search') {
    const query = arguments_['query']
    if (typeof query !== 'string' || query.trim() === '') throw new Error('mail_search needs a Gmail search expression.')
    const rawLimit = typeof arguments_['limit'] === 'number' ? arguments_['limit'] : SEARCH_LIMIT_DEFAULT
    const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(rawLimit)))
    const requested = typeof arguments_['mailbox'] === 'string' ? arguments_['mailbox'] : DEFAULT_MAILBOX
    const found = await search(query, limit, requested)
    // The resolved path travels back out, so passing it to mail_read is a copy rather
    // than a guess at what this account calls its all-mail folder.
    return { mailbox: found.mailbox, query, count: found.hits.length, messages: found.hits }
  }
  if (name === 'mail_read') {
    const raw = arguments_['uids']
    const uids = Array.isArray(raw) ? raw.filter((value): value is number => typeof value === 'number') : []
    if (uids.length === 0) throw new Error('mail_read needs at least one uid from mail_search.')
    if (uids.length > READ_LIMIT_MAX) throw new Error(`mail_read takes at most ${READ_LIMIT_MAX} uids at a time.`)
    const requested = typeof arguments_['mailbox'] === 'string' ? arguments_['mailbox'] : DEFAULT_MAILBOX
    return read(uids, requested)
  }
  if (name === 'mail_draft') {
    const to = Array.isArray(arguments_['to']) ? arguments_['to'].filter((value): value is string => typeof value === 'string') : []
    const cc = Array.isArray(arguments_['cc']) ? arguments_['cc'].filter((value): value is string => typeof value === 'string') : []
    const subject = arguments_['subject']
    const body = arguments_['body']
    if (to.length === 0) throw new Error('mail_draft needs at least one recipient.')
    if (typeof subject !== 'string') throw new Error('mail_draft needs a subject.')
    if (typeof body !== 'string' || body.trim() === '') throw new Error('mail_draft needs a plain-text body.')
    const saved = await draft({
      to,
      cc,
      subject,
      body,
      ...(typeof arguments_['replyToUid'] === 'number' ? { replyToUid: arguments_['replyToUid'] } : {}),
      mailbox: typeof arguments_['mailbox'] === 'string' ? arguments_['mailbox'] : DEFAULT_MAILBOX,
    })
    return { saved: true, folder: saved.mailbox, subject: saved.subject, note: 'Draft saved. It has not been sent.' }
  }
  throw new Error(`Unknown mail tool ${name}.`)
}

async function main(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const send = (message: JsonRecord) => process.stdout.write(`${JSON.stringify(message)}\n`)

  for await (const line of input) {
    let request: unknown
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(request) || request['jsonrpc'] !== '2.0') continue
    const id = request['id']
    const method = request['method']
    if (method === 'notifications/initialized') continue
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'manor-mail', version: '0.1.0' },
          instructions: instructions(),
        },
      })
      continue
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: tools() } })
      continue
    }
    if (method !== 'tools/call') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } })
      continue
    }
    const params = isRecord(request['params']) ? request['params'] : {}
    const name = typeof params['name'] === 'string' ? params['name'] : ''
    const arguments_ = isRecord(params['arguments']) ? params['arguments'] : {}
    try {
      const result = await call(name, arguments_)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })
    } catch (error: unknown) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'The mail action failed.' }],
        },
      })
    }
  }
}

// Importable for tests without starting a server on their stdin.
if (process.argv[1] !== undefined && /mailMcp\.(?:ts|mjs)$/.test(process.argv[1])) {
  void main().catch((error: unknown) => {
    process.stderr.write(`[manor-mail] ${error instanceof Error ? error.message : 'startup failed'}\n`)
    process.exitCode = 1
  })
}

export { htmlToText, stripQuotes, textNode, headerValue, recipient }
