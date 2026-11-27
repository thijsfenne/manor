import { mailForwardSubject, type ClientMessage } from '@manor/contracts'
import type { MailCache, MailInboxThread } from './mailCache.js'
import type { OutboundAttachment, OutboundSendPort } from './outboundSend.js'

type MailSendMessage = Extract<ClientMessage, { type: 'mail_send' }>

export type MailSendOutcome = { ok: true } | { ok: false; message: string }

interface MailSendOptions {
  /** Read per send: a damaged cache file is replaced while the server runs. */
  cache: () => MailCache | undefined
  port: OutboundSendPort
  /** The bytes of the attachments a forward carries, read from the mailbox when the user sends. */
  attachments: (thread: MailInboxThread, messageId: string, files: readonly number[]) => Promise<OutboundAttachment[]>
  /** The mailbox's own address: the only account a reply may leave from. */
  account: string
  /** `Re: <subject>` of the thread, the only subject a reply carries. */
  subject: (subject: string) => string
  now: () => number
}

/** A send claim the next attempt must answer for: whether it left is unknown. */
const CHECK_SENT = 'An earlier send of this reply may have left without Manor hearing back. Check Sent in your mailbox first; send again only if it is not there.'

/**
 * The user's Send, the only way mail leaves the Mail door. A reply goes through the
 * outbound port as a threaded Gmail reply, so the port's reply-header check applies and
 * a thread it cannot resolve is refused instead of leaving as new mail. A forward is new
 * mail by intent: it leaves under `Fwd:` with no thread, as plain text with the
 * attachments of the forwarded message the user kept. Every attempt is claimed in the
 * cache before the port is called and its outcome written after, so a send cut off by a
 * crash is never silently repeated.
 */
export class MailSender {
  /** Threads with a send in flight in this process. */
  private readonly sending = new Set<string>()

  constructor(private readonly options: MailSendOptions) {}

  async send(message: MailSendMessage): Promise<MailSendOutcome> {
    const { port, account, now } = this.options
    const { requestId, threadId } = message
    const cache = this.options.cache()
    if (cache === undefined) return { ok: false, message: 'Not sent: this Manor host has no mailbox.' }
    const thread = cache.inboxThread(threadId)
    if (thread === undefined) return { ok: false, message: 'Not sent: this thread is no longer in the Inbox.' }
    const { forward } = message
    if (forward === undefined && thread.gmailThreadId === undefined) {
      return { ok: false, message: 'Not sent: this mailbox gives no thread id for this mail, so the reply could not be filed in its thread. Reply from your mail app instead.' }
    }
    if (this.sending.has(threadId)) return { ok: false, message: 'Not sent: a reply to this thread is already on its way.' }
    // The newest claim decides: an uncertain one is answered once, by this refusal.
    const [newest] = cache.sendClaims(threadId)
    if (newest?.status === 'uncertain') {
      cache.recordSendClaim({ requestId, threadId, status: 'refused', message: CHECK_SENT, at: Math.max(now(), newest.at + 1) })
      return { ok: false, message: `Not sent. ${CHECK_SENT}` }
    }
    this.sending.add(threadId)
    try {
      let attachments: OutboundAttachment[] = []
      if (forward !== undefined && forward.files.length > 0) {
        try {
          attachments = await this.options.attachments(thread, forward.messageId, [...new Set(forward.files)])
        } catch (error: unknown) {
          // Nothing left yet, so this needs no claim.
          return { ok: false, message: `Not sent: the attachments could not be read. ${error instanceof Error ? error.message : ''}`.trimEnd() }
        }
      }
      cache.recordSendClaim({ requestId, threadId, status: 'started', at: now() })
      const cc = message.cc?.trim() ?? ''
      let outcome: MailSendOutcome & { certain?: boolean }
      try {
        const result = await port.send({
          channel: 'gmail',
          submissionId: requestId,
          from: account,
          to: message.to.trim(),
          ...(cc === '' ? {} : { cc }),
          subject: forward === undefined ? this.options.subject(thread.subject) : mailForwardSubject(thread.subject),
          body: message.body,
          ...(forward !== undefined || thread.gmailThreadId === undefined ? {} : { gmailThreadId: thread.gmailThreadId }),
          ...(attachments.length === 0 ? {} : { attachments }),
        })
        outcome = result.ok ? { ok: true } : { ok: false, message: result.message, certain: result.certainty === 'safe' }
      } catch (error: unknown) {
        outcome = { ok: false, message: `Manor could not tell whether the reply left: ${error instanceof Error ? error.message : 'the send failed'}`, certain: false }
      }
      if (outcome.ok) {
        cache.recordSendClaim({ requestId, threadId, status: 'sent', at: now() })
        // Answered: from here the user waits for the other side. A label of the user's own.
        if (forward === undefined && cache.label(threadId)?.label === 'reply') cache.setLabel(threadId, 'wait', 'user', undefined, now())
        return { ok: true }
      }
      cache.recordSendClaim({ requestId, threadId, status: outcome.certain === true ? 'refused' : 'uncertain', message: outcome.message, at: now() })
      return { ok: false, message: outcome.message }
    } finally {
      this.sending.delete(threadId)
    }
  }
}
