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
import { readMailReplyHeaders, type MailReplyHeaders } from './mcp/mailMcp.js'

export interface OutboundSendRequest {
  channel: OutboundChannel
  to: string
  subject?: string
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
  ) {}

  async send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    return request.channel === 'gmail' ? this.sendGmail(request) : this.sendSlack(request)
  }

  private async sendGmail(request: OutboundSendRequest): Promise<OutboundSendResult> {
    const user = this.env.MANOR_MAIL_IMAP_USER
    const pass = this.env.MANOR_MAIL_IMAP_PASSWORD
    if (user === undefined || user === '' || pass === undefined || pass === '') {
      return { ok: false, certainty: 'safe', message: `Gmail sending is unavailable because the personal mail connection is not configured.` }
    }

    const to = recipient(request.to)
    if (to === undefined) {
      return { ok: false, certainty: 'safe', message: `Gmail could not send this draft because "${request.to.replace(/[\r\n]+/g, ' ')}" is not one email address.` }
    }

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
      await gmail.sendMail({
        from: user,
        to,
        subject: request.subject ?? '',
        text: request.body,
        messageId: `<${request.submissionId}@manor.local>`,
        ...(reply === undefined ? {} : { inReplyTo: reply.inReplyTo, references: reply.references }),
      })
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
}

export class RecordingOutboundSend implements OutboundSendPort {
  readonly sent: OutboundSendRequest[] = []

  async send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    this.sent.push(request)
    return { ok: true, delivery: 'recorded' }
  }
}

export function createOutboundSendPort(): OutboundSendPort {
  return new ConfirmedOutboundSend()
}
