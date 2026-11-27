import type { MailAddress, MailMessage } from '@manor/contracts'
import type { OutboundAttachment } from './outboundSend.js'

/**
 * The Mail door's one way into a mailbox. The IMAP source talks to the user's real
 * account, the fixture source is an in-memory stand-in for tests and mock mode. Nothing
 * else in the server reads or writes mail for the door.
 *
 * The only write is `archive` and its Undo `restore`. Reading never marks mail read.
 * Attachment bytes are read only by `readAttachments`, for a forward the user sends.
 */
export interface MailSource {
  /** The mailbox's own address, lowercased. A message from it is `mine`. */
  account(): string
  /** The newest `limit` messages of the Inbox, headers and flags only. */
  listInbox(limit: number): Promise<MailInbox>
  /**
   * Every message of one thread, oldest first, including the account's own replies. Each
   * carries its plain text, and its HTML part when that came whole and within the caps.
   */
  readThread(thread: MailThreadRef): Promise<MailMessage[]>
  /**
   * The bytes of some attachments of one message of the thread, for a forward the user
   * sends. `files` are their places in that message's `attachments` list as `readThread`
   * gave it, and the answer keeps their order. Rejects when the message or a place is no
   * longer there, or when the files weigh more than `maxBytes` together.
   */
  readAttachments(thread: MailThreadRef, messageId: string, files: readonly number[], maxBytes: number): Promise<OutboundAttachment[]>
  /** Takes the thread's Inbox messages out of the Inbox. The receipt is what `restore` needs. */
  archive(thread: MailThreadRef): Promise<MailArchiveReceipt>
  /** Puts what `archive` took back in the Inbox. */
  restore(receipt: MailArchiveReceipt): Promise<void>
}

/** Opaque to everyone but the source that wrote it; the cache stores it as is for Undo. */
export type MailArchiveReceipt = string

export interface MailInbox {
  /** The Inbox's UIDVALIDITY. A new value means every cached uid is meaningless. */
  uidValidity: string
  /** Oldest first, at most the asked limit. */
  messages: MailEnvelope[]
}

export interface MailEnvelope {
  uid: number
  /** The Gmail thread id when the server gives one, else `<uidValidity>:<uid>`. */
  threadId: string
  /** Present only on a server that numbers threads itself (Gmail's X-GM-THRID, decimal). */
  gmailThreadId?: string
  /** The RFC 5322 Message-ID, angle brackets included, when the message carried one. */
  messageId?: string
  subject: string
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  /** Milliseconds since the epoch. */
  at: number
  /** When the server took the message in, which no sender can set. Absent when it gives none. */
  receivedAt?: number
  seen: boolean
}

/** One thread as the cache knows it: what a source needs to read or archive it. */
export interface MailThreadRef {
  threadId: string
  gmailThreadId?: string
  uidValidity: string
  /** The thread's Inbox uids under `uidValidity`, oldest first. */
  uids: number[]
}

/** The thread key of a server without its own thread ids: every message stands alone. */
export const singleMessageThreadId = (uidValidity: string, uid: number) => `${uidValidity}:${uid}`

/** Lowercased bare address, or the trimmed input when it has no `@` to stand on. */
export const normalAddress = (address: string) => address.trim().toLowerCase()
