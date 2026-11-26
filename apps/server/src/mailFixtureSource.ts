import type { MailAddress, MailMessage } from '@manor/contracts'
import type { MailArchiveReceipt, MailEnvelope, MailInbox, MailSource, MailThreadRef } from './mailSource.js'

interface FixtureMessage {
  uid: number
  threadId: string
  messageId: string
  subject: string
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  at: number
  receivedAt?: number
  seen: boolean
  /** False for the account's own sent replies, which live outside the Inbox. */
  inbox: boolean
  text: string
  attachments: { name: string; kb: number }[]
}

const HOUR = 60 * 60 * 1000
/** The address the mock Composio Gmail account reports, so a spike's Send passes the port's sender check. */
const ACCOUNT: MailAddress = { name: 'You', address: 'you@example.com' }

const person = (name: string, address: string): MailAddress => ({ name, address })
const recruiter = person('Nora Example', 'nora@talent.example')
const council = person('Parking Services', 'parking@city-council.example')
const studio = person('Ruben Example', 'ruben@studio.example')
const tracker = person('Issue Tracker', 'digest@issues.example')
const family = person('Ingrid Example', 'ingrid@family.example')
const careers = person('Careers', 'no-reply@jobs.example')

/** Gmail-shaped thread ids, so a send path that needs one finds one. */
export const FIXTURE_THREAD = {
  interview: '1790000000000000001',
  parking: '1790000000000000002',
  waiting: '1790000000000000003',
  digest: '1790000000000000004',
  family: '1790000000000000005',
  application: '1790000000000000006',
} as const

/** Six threads modelled on the design's Inbox; `now` anchors their times. */
function seed(now: number): FixtureMessage[] {
  let uid = 100
  const message = (fields: Omit<FixtureMessage, 'uid' | 'messageId' | 'cc' | 'attachments'> & Partial<Pick<FixtureMessage, 'cc' | 'attachments'>>): FixtureMessage => {
    uid += 1
    return { uid, messageId: `<m${uid}@fixture.example>`, cc: [], attachments: [], ...fields }
  }
  return [
    message({
      threadId: FIXTURE_THREAD.application,
      subject: 'We received your application',
      from: careers,
      to: [ACCOUNT],
      at: now - 50 * HOUR,
      seen: true,
      inbox: true,
      text: 'Thank you for applying for the role of Operations Lead.\n\nThis is an automatic confirmation. Our team reviews every application and will contact you within three weeks if your profile matches.\n\nPlease do not reply to this message.',
    }),
    message({
      threadId: FIXTURE_THREAD.waiting,
      subject: 'Quote for the spring brochure',
      from: ACCOUNT,
      to: [studio],
      at: now - 40 * HOUR,
      seen: true,
      inbox: true,
      text: 'Hi Ruben,\n\nCould you send me a quote for the spring brochure? Twelve pages, a print run of 500, delivery before the end of February.\n\nThanks,\nYou',
    }),
    message({
      threadId: FIXTURE_THREAD.interview,
      subject: 'Second round interview',
      from: recruiter,
      to: [ACCOUNT],
      cc: [person('Hiring Team', 'hiring@talent.example')],
      at: now - 30 * HOUR,
      seen: false,
      inbox: true,
      text: 'Hello,\n\nThank you for the first conversation. We would like to invite you for a second round with the team lead.\n\nCould you let me know which days next week suit you?\n\nKind regards,\nNora Example',
      attachments: [{ name: 'interview-agenda.pdf', kb: 84 }],
    }),
    message({
      threadId: FIXTURE_THREAD.interview,
      subject: 'Re: Second round interview',
      from: ACCOUNT,
      to: [recruiter],
      at: now - 26 * HOUR,
      seen: true,
      inbox: false,
      text: 'Hi Nora,\n\nThank you, I would be glad to come. Tuesday or Thursday morning works best for me.\n\nBest,\nYou',
    }),
    message({
      threadId: FIXTURE_THREAD.digest,
      subject: 'Weekly digest: 12 issues updated',
      from: tracker,
      to: [ACCOUNT],
      at: now - 20 * HOUR,
      seen: true,
      inbox: true,
      text: 'Your weekly summary\n\n12 issues were updated this week.\n3 issues were closed.\n2 new issues are assigned to you.\n\nOpen the tracker to see the full list.',
    }),
    message({
      threadId: FIXTURE_THREAD.parking,
      subject: 'Your parking permit expires on 31 December',
      from: council,
      to: [ACCOUNT],
      at: now - 8 * HOUR,
      seen: false,
      inbox: true,
      text: 'Dear resident,\n\nYour residential parking permit expires on 31 December. Renew it before that date to keep parking in your zone.\n\nYou can renew online with your permit number. The fee for next year is unchanged.\n\nParking Services',
    }),
    message({
      threadId: FIXTURE_THREAD.family,
      subject: 'Komen jullie zondag eten?',
      from: family,
      to: [ACCOUNT],
      at: now - 5 * HOUR,
      seen: false,
      inbox: true,
      text: 'Hoi!\n\nKomen jullie zondag bij ons eten? We dachten aan half zes. Laat even weten of het past, dan haal ik zaterdag de boodschappen.\n\nLiefs,\nIngrid',
    }),
    message({
      threadId: FIXTURE_THREAD.interview,
      subject: 'Re: Second round interview',
      from: recruiter,
      to: [ACCOUNT],
      cc: [person('Hiring Team', 'hiring@talent.example')],
      at: now - 2 * HOUR,
      seen: false,
      inbox: true,
      text: 'Hi,\n\nThursday at 10:00 works for the team lead. Would that suit you? The interview takes about an hour, at our office.\n\nKind regards,\nNora Example',
    }),
  ]
}

/**
 * An in-memory mailbox for tests and mock mode, so neither ever reaches a real account.
 * It keeps `seen` flags and Inbox membership like a server would, which is what lets a
 * test prove that opening leaves mail unread and that archive and Undo round-trip.
 */
export class MailFixtureSource implements MailSource {
  private messages: FixtureMessage[]
  private uidValidity = '1'

  constructor(options: { now?: number } = {}) {
    this.messages = seed(options.now ?? Date.now())
  }

  account(): string {
    return ACCOUNT.address
  }

  async listInbox(limit: number): Promise<MailInbox> {
    const inbox = this.messages.filter((message) => message.inbox).sort((left, right) => left.uid - right.uid).slice(-limit)
    return { uidValidity: this.uidValidity, messages: inbox.map((message) => this.envelope(message)) }
  }

  async readThread(thread: MailThreadRef): Promise<MailMessage[]> {
    return this.messages
      .filter((message) => message.threadId === thread.threadId)
      .sort((left, right) => left.at - right.at)
      .map((message) => ({
        id: message.messageId,
        from: message.from,
        to: message.to,
        cc: message.cc,
        at: message.at,
        text: message.text,
        truncated: false,
        attachments: message.attachments,
        mine: message.from.address === ACCOUNT.address,
      }))
  }

  async archive(thread: MailThreadRef): Promise<MailArchiveReceipt> {
    const taken = this.messages.filter((message) => message.threadId === thread.threadId && message.inbox)
    if (taken.length === 0) throw new Error('This thread is no longer in the Inbox.')
    for (const message of taken) message.inbox = false
    return JSON.stringify({ messageIds: taken.map((message) => message.messageId) })
  }

  async restore(receipt: MailArchiveReceipt): Promise<void> {
    const { messageIds } = JSON.parse(receipt) as { messageIds: string[] }
    for (const message of this.messages) if (messageIds.includes(message.messageId)) message.inbox = true
  }

  /** For tests: whether a message is still unread on this "server". */
  seen(uid: number): boolean {
    return this.messages.find((message) => message.uid === uid)?.seen ?? false
  }

  /** For tests: whether any message of the thread is in the Inbox. */
  inInbox(threadId: string): boolean {
    return this.messages.some((message) => message.threadId === threadId && message.inbox)
  }

  /** For tests: the server renumbered its Inbox, as after a mailbox rebuild. */
  renumber(uidValidity: string, offset: number): void {
    this.uidValidity = uidValidity
    for (const message of this.messages) message.uid += offset
  }

  /** For tests: a message that arrived after the first poll. */
  deliver(fields: { threadId: string; subject: string; from: MailAddress; text: string; at: number; receivedAt?: number }): number {
    const uid = Math.max(...this.messages.map((message) => message.uid)) + 1
    this.messages.push({ uid, messageId: `<m${uid}@fixture.example>`, to: [ACCOUNT], cc: [], seen: false, inbox: true, attachments: [], ...fields })
    return uid
  }

  private envelope(message: FixtureMessage): MailEnvelope {
    return {
      uid: message.uid,
      threadId: message.threadId,
      gmailThreadId: message.threadId,
      messageId: message.messageId,
      subject: message.subject,
      from: message.from,
      to: message.to,
      cc: message.cc,
      at: message.at,
      ...(message.receivedAt === undefined ? {} : { receivedAt: message.receivedAt }),
      seen: message.seen,
    }
  }
}
