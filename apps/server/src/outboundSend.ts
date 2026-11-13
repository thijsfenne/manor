import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  SlackRichTextSchema,
  slackRichTextFallback,
  slackRichTextForPost,
  type SlackRichText,
  isOutboundSlackChannelId,
  isOutboundSlackThreadTs,
  type OutboundChannel,
  type OutboundMailAccount,
} from '@manor/contracts'
import nodemailer from 'nodemailer'
import type { ComposioExecution } from './mcp/composioRegistration.js'
import { readMailReplyHeaders, type MailReplyHeaders } from './mcp/mailMcp.js'

export interface OutboundSendRequest {
  channel: OutboundChannel
  to: string
  subject?: string
  /** Gmail only: comma-separated addresses. */
  cc?: string
  /** Gmail only: the From address the card showed. A send from any other account is refused. */
  from?: string
  body: string
  mailAccount?: OutboundMailAccount
  /** The card's Gmail thread. Present means Submit must send a threaded reply, never new mail. */
  gmailThreadId?: string
  slackChannelId?: string
  slackThreadTs?: string
  slackRichText?: SlackRichText
  /** Durable claim id, reused as provider idempotency metadata where supported. */
  submissionId: string
}

export type OutboundSendResult =
  | { ok: true; delivery: 'recorded' | 'delivered' }
  | { ok: false; certainty: 'safe' | 'uncertain'; message: string }

/**
 * The last centimetre: Manor never auto-sends. Submit is the only caller, and the
 * recording implementation keeps the boundary testable without touching a mailbox.
 */
export interface OutboundSendPort {
  send(request: OutboundSendRequest): Promise<OutboundSendResult>
  /**
   * How a draft on this channel would leave right now, or undefined when nothing on
   * this host can send it. Absent means every channel is routable (the test port).
   */
  route?(channel: OutboundChannel): Promise<OutboundRoute | undefined>
}

/** Where a send goes: the host's own credentials first, a Composio account second. */
export type OutboundRoute =
  | { kind: 'native'; from?: string }
  | { kind: 'composio'; accountId: string; from?: string }

/**
 * The Composio side of sending, so a new user with Gmail or Slack connected there can
 * send without the host's own mail or Slack setup. Server-side tool calls on the
 * user's connected account; no agent session is involved.
 */
export interface ComposioOutbound {
  /** False when this host has no Composio key: no account can exist and no link can be made. */
  available(): boolean
  /** The connected account to send from, preferring the personal alias. */
  account(toolkit: OutboundChannel): Promise<string | undefined>
  execute(toolSlug: string, accountId: string, arguments_: Record<string, unknown>): Promise<ComposioExecution>
}

interface GmailTransportOptions {
  service: 'gmail'
  auth: { user: string; pass: string }
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
}

interface GmailMessage {
  from: string
  to: string
  cc?: string[]
  subject: string
  text: string
  messageId: string
  inReplyTo?: string
  references?: string[]
}

interface GmailTransport {
  sendMail(message: GmailMessage): Promise<unknown>
}

type GmailTransportFactory = (options: GmailTransportOptions) => GmailTransport

const defaultGmailTransport: GmailTransportFactory = (options) => nodemailer.createTransport(options)

type GmailReplyResolver = (threadId: string) => Promise<MailReplyHeaders>

interface SlackCredentials {
  token: string
  cookie: string
}

type SlackCredentialsLoader = () => Promise<SlackCredentials>
type SlackFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null

const defaultSlackCredentials: SlackCredentialsLoader = async () => {
  const raw = await readFile(join(homedir(), '.claude.json'), 'utf8')
  const config: unknown = JSON.parse(raw)
  const servers = isRecord(config) && isRecord(config['mcpServers']) ? config['mcpServers'] : {}
  const slack = isRecord(servers['slack']) ? servers['slack'] : {}
  const env = isRecord(slack['env']) ? slack['env'] : {}
  const token = env['SLACK_TOKEN']
  const cookie = env['SLACK_COOKIE']
  if (typeof token !== 'string' || token === '' || typeof cookie !== 'string' || cookie === '') {
    throw new Error('the authenticated Slack session is not configured on this host')
  }
  return { token, cookie }
}

/** Every address of a comma-separated Cc line, or undefined when one of them is not an address. */
function recipients(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return []
  const list = value.split(',').map((entry) => recipient(entry))
  return list.every((entry): entry is string => entry !== undefined) ? list : undefined
}

/** The bare address of `Name <address>`, which Composio's Gmail tools require. */
const bareAddress = (value: string) => /<([^<>]+)>$/.exec(value)?.[1] ?? value

/** GMAIL_GET_PROFILE answers the address directly or wrapped once more under `data`. */
function profileAddress(data: Record<string, unknown>): string | undefined {
  const nested = typeof data['data'] === 'object' && data['data'] !== null ? data['data'] as Record<string, unknown> : {}
  const address = data['emailAddress'] ?? nested['emailAddress']
  return typeof address === 'string' && address.length > 0 ? address : undefined
}

const sameAddress = (left: string | undefined, right: string) =>
  left !== undefined && bareAddress(left).toLowerCase() === bareAddress(right).toLowerCase()

/** The card named one sender; the account that would send now is another, or unreadable. */
const senderChanged = (from: string): OutboundSendResult => ({
  ok: false,
  certainty: 'safe',
  message: `Not sent: the connected Gmail account is no longer ${from}. Ask for the draft again to send from the current account.`,
})

/** Recipients nodemailer reports as refused; its answer carries `rejected` beside `accepted`. */
function rejectedRecipients(info: unknown): string[] {
  const rejected = typeof info === 'object' && info !== null ? (info as { rejected?: unknown }).rejected : undefined
  if (!Array.isArray(rejected)) return []
  return rejected.map((entry: unknown) => typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && 'address' in entry ? String(entry.address) : '').filter((entry) => entry !== '')
}

function composioFailure(channel: 'Gmail' | 'Slack', result: Exclude<ComposioExecution, { status: 'ok' }>): OutboundSendResult {
  return {
    ok: false,
    certainty: result.status === 'refused' ? 'safe' : 'uncertain',
    message: `${channel} could not send this draft through Composio: ${result.message}`,
  }
}

function recipient(value: string): string | undefined {
  const address = value.trim()
  if (address.length === 0 || /[\r\n]/.test(address)) return undefined
  if (/^[^@<>\s]+@[^@<>\s]+\.[^@<>\s]+$/.test(address)) return address
  if (/^[^<>]*<[^@<>\s]+@[^@<>\s]+\.[^@<>\s]+>$/.test(address)) return address
  return undefined
}

/**
 * The human-confirmed Gmail path. Agents still cannot send: they can only leave a
 * draft in the transcript, and this port is reached exclusively by the UI's Submit.
 */
export class ConfirmedOutboundSend implements OutboundSendPort {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly transport: GmailTransportFactory = defaultGmailTransport,
    private readonly slackCredentials: SlackCredentialsLoader = defaultSlackCredentials,
    private readonly slackFetch: SlackFetch = fetch,
    private readonly gmailReply: GmailReplyResolver = readMailReplyHeaders,
    private readonly composio?: ComposioOutbound,
  ) {}

  async route(channel: OutboundChannel): Promise<OutboundRoute | undefined> {
    if (channel === 'gmail') {
      const user = this.gmailUser()
      if (user !== undefined) return { kind: 'native', from: user }
    } else if (await this.slackCredentials().then(() => true, () => false)) {
      return { kind: 'native' }
    }
    if (this.composio?.available() !== true) return undefined
    const accountId = await this.composio.account(channel).catch(() => undefined)
    if (accountId === undefined) return undefined
    if (channel === 'slack') return { kind: 'composio', accountId }
    // The address is only for the card's From row, so a slow or failed read leaves it out.
    const profile = await this.composio.execute('GMAIL_GET_PROFILE', accountId, { user_id: 'me' }).catch(() => undefined)
    const from = profile?.status === 'ok' ? profileAddress(profile.data) : undefined
    return { kind: 'composio', accountId, ...(from === undefined ? {} : { from }) }
  }

  async send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    return request.channel === 'gmail' ? this.sendGmail(request) : this.sendSlack(request)
  }

  private gmailUser(): string | undefined {
    const user = this.env.MANOR_MAIL_IMAP_USER
    const pass = this.env.MANOR_MAIL_IMAP_PASSWORD
    return user === undefined || user === '' || pass === undefined || pass === '' ? undefined : user
  }

  private async composioAccount(channel: OutboundChannel): Promise<string | undefined> {
    if (this.composio?.available() !== true) return undefined
    return this.composio.account(channel).catch(() => undefined)
  }

  private async sendGmail(request: OutboundSendRequest): Promise<OutboundSendResult> {
    const to = recipient(request.to)
    if (to === undefined) {
      return { ok: false, certainty: 'safe', message: `Gmail could not send this draft because "${request.to.replace(/[\r\n]+/g, ' ')}" is not one email address.` }
    }
    const cc = recipients(request.cc)
    if (cc === undefined) {
      return { ok: false, certainty: 'safe', message: 'Gmail could not send this draft because the Cc line holds something that is not an email address.' }
    }

    const user = this.env.MANOR_MAIL_IMAP_USER
    const pass = this.env.MANOR_MAIL_IMAP_PASSWORD
    if (user === undefined || user === '' || pass === undefined || pass === '') {
      const accountId = await this.composioAccount('gmail')
      if (accountId === undefined) return { ok: false, certainty: 'safe', message: 'Gmail sending is unavailable because no Gmail account is connected.' }
      // A Composio account can be swapped behind Manor's back, so it sends only as the
      // address its card showed. A card without one never names who it would send as.
      if (request.from === undefined) return { ok: false, certainty: 'safe', message: 'Not sent: this draft does not say which Gmail account sends it. Ask for the draft again.' }
      const profile = await this.composio?.execute('GMAIL_GET_PROFILE', accountId, { user_id: 'me' }).catch(() => undefined)
      const current = profile?.status === 'ok' ? profileAddress(profile.data) : undefined
      if (!sameAddress(current, request.from)) return senderChanged(request.from)
      return this.sendGmailComposio(request, accountId, to, cc)
    }
    if (request.from !== undefined && !sameAddress(user, request.from)) return senderChanged(request.from)

    // Gmail files a reply in its thread only by the original's Message-ID. Without
    // those headers the reply lands as new mail, so an unreadable thread refuses
    // before any SMTP connection, leaving the card open for a retry.
    let reply: MailReplyHeaders | undefined
    if (request.gmailThreadId !== undefined) {
      try {
        reply = await this.gmailReply(request.gmailThreadId)
      } catch (error: unknown) {
        return {
          ok: false,
          certainty: 'safe',
          message: `Gmail did not send this reply because the original thread could not be read: ${error instanceof Error ? error.message : 'the mailbox gave no reason'}`,
        }
      }
    }

    try {
      const gmail = this.transport({
        service: 'gmail',
        auth: { user, pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      })
      const info = await gmail.sendMail({
        from: user,
        to,
        ...(cc.length === 0 ? {} : { cc }),
        subject: request.subject ?? '',
        text: request.body,
        messageId: `<${request.submissionId}@manor.local>`,
        ...(reply === undefined ? {} : { inReplyTo: reply.inReplyTo, references: reply.references }),
      })
      // SMTP may take the mail for some recipients and refuse others. Part of it left, so
      // Send stays locked against a duplicate, but nothing may claim it reached everyone.
      const refused = rejectedRecipients(info)
      if (refused.length > 0) {
        return {
          ok: false,
          certainty: 'uncertain',
          message: `Gmail refused ${refused.join(', ')} but may have sent to the others. Check Sent before sending again.`,
        }
      }
      return { ok: true, delivery: 'delivered' }
    } catch (error: unknown) {
      return {
        ok: false,
        certainty: 'uncertain',
        message: `Gmail could not send this draft: ${error instanceof Error ? error.message : 'the SMTP server gave no reason'}`,
      }
    }
  }

  private async sendSlack(request: OutboundSendRequest): Promise<OutboundSendResult> {
    const channel = request.slackChannelId?.trim()
    if (!isOutboundSlackChannelId(channel)) {
      return { ok: false, certainty: 'safe', message: 'Slack could not send this draft because it has no valid conversation id.' }
    }
    const threadTs = request.slackThreadTs?.trim()
    if (threadTs !== undefined && !isOutboundSlackThreadTs(threadTs)) {
      return { ok: false, certainty: 'safe', message: 'Slack could not send this draft because its thread timestamp is invalid.' }
    }

    const richText = request.slackRichText === undefined ? undefined : SlackRichTextSchema.safeParse(request.slackRichText)
    if (richText !== undefined && !richText.success) {
      return { ok: false, certainty: 'safe', message: 'Slack could not send this draft because its formatting is invalid.' }
    }

    let credentials: SlackCredentials
    try {
      credentials = await this.slackCredentials()
    } catch (error: unknown) {
      const accountId = await this.composioAccount('slack')
      if (accountId !== undefined) return this.sendSlackComposio(request, accountId, channel, threadTs, richText?.success ? richText.data : undefined)
      return {
        ok: false,
        certainty: 'safe',
        message: `Slack could not send this draft: ${error instanceof Error ? error.message : 'the authenticated session is unavailable'}`,
      }
    }

    try {
      const form = new URLSearchParams({ channel, text: richText?.success ? slackRichTextFallback(richText.data) : request.body })
      if (richText?.success) {
        form.set('blocks', JSON.stringify([slackRichTextForPost(richText.data)]))
        form.set('mrkdwn', 'false')
        form.set('parse', 'none')
      }
      form.set('client_msg_id', request.submissionId)
      if (threadTs !== undefined) form.set('thread_ts', threadTs)
      const response = await this.slackFetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.token}`,
          cookie: `d=${credentials.cookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      })
      const payload: unknown = await response.json().catch(() => undefined)
      if (!isRecord(payload)) {
        return { ok: false, certainty: 'uncertain', message: 'Slack could not confirm whether this draft was accepted.' }
      }
      if (!response.ok || payload['ok'] !== true) {
        const reason = isRecord(payload) && typeof payload['error'] === 'string'
          ? payload['error']
          : `HTTP ${response.status}`
        return { ok: false, certainty: 'safe', message: `Slack could not send this draft: ${reason}` }
      }
      return { ok: true, delivery: 'delivered' }
    } catch (error: unknown) {
      return {
        ok: false,
        certainty: 'uncertain',
        message: `Slack could not send this draft: ${error instanceof Error ? error.message : 'the API gave no reason'}`,
      }
    }
  }

  /**
   * Gmail through the user's Composio account. A reply goes through the thread tool,
   * which files it by Gmail's own thread id, so a missing thread fails instead of
   * leaving as new mail. The signature stays off: the approved text is what goes.
   */
  private async sendGmailComposio(request: OutboundSendRequest, accountId: string, to: string, cc: string[]): Promise<OutboundSendResult> {
    const composio = this.composio
    if (composio === undefined) return { ok: false, certainty: 'safe', message: 'Composio is not available on this host.' }
    const shared = { recipient_email: bareAddress(to), cc: cc.map(bareAddress), include_signature: false, is_html: false }
    const result = await composio.execute(
      request.gmailThreadId === undefined ? 'GMAIL_SEND_EMAIL' : 'GMAIL_REPLY_TO_THREAD',
      accountId,
      request.gmailThreadId === undefined
        ? { ...shared, subject: request.subject ?? '', body: request.body }
        : { ...shared, thread_id: request.gmailThreadId, message_body: request.body },
    )
    return result.status === 'ok' ? { ok: true, delivery: 'delivered' } : composioFailure('Gmail', result)
  }

  private async sendSlackComposio(
    request: OutboundSendRequest,
    accountId: string,
    channel: string,
    threadTs: string | undefined,
    richText: SlackRichText | undefined,
  ): Promise<OutboundSendResult> {
    const composio = this.composio
    if (composio === undefined) return { ok: false, certainty: 'safe', message: 'Composio is not available on this host.' }
    const result = await composio.execute('SLACK_SEND_MESSAGE', accountId, {
      channel,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
      ...(richText === undefined
        ? { markdown_text: request.body }
        : { blocks: [slackRichTextForPost(richText)], fallback_text: slackRichTextFallback(richText) }),
    })
    return result.status === 'ok' ? { ok: true, delivery: 'delivered' } : composioFailure('Slack', result)
  }
}

export class RecordingOutboundSend implements OutboundSendPort {
  readonly sent: OutboundSendRequest[] = []

  async send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    this.sent.push(request)
    return { ok: true, delivery: 'recorded' }
  }
}

/**
 * The spike's sender: the real Composio path over the mock accounts, with no host
 * mailbox or Slack session, so nothing on this Mac is ever read or sent.
 */
export function createMockOutboundSendPort(composio: ComposioOutbound): ConfirmedOutboundSend {
  return new ConfirmedOutboundSend({}, defaultGmailTransport, async () => {
    throw new Error('the spike has no Slack session')
  }, fetch, readMailReplyHeaders, composio)
}

export function createOutboundSendPort(composio?: ComposioOutbound): ConfirmedOutboundSend {
  return new ConfirmedOutboundSend(process.env, defaultGmailTransport, defaultSlackCredentials, fetch, readMailReplyHeaders, composio)
}
