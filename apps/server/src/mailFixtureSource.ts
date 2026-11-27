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
  /** The plain version, which is all an agent reads. */
  text: string
  /** The sender's own HTML part, for the client's mail view. */
  html?: string
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
const shop = person('Garden Supply', 'news@garden-supply.example')
const hospital = person('', 'no_reply@hospital.example')
const bikeShop = person('City Bikes', 'receipts@city-bikes.example')
const swimSchool = person('Swim School', 'noreply@swim-school.example')

/**
 * Two public, stable pictures from a free media archive. The isolated verify server
 * really fetches them through the image proxy, so they must stay reachable without cookies.
 */
export const FIXTURE_NEWSLETTER_IMAGES = [
  'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Fronalpstock_big.jpg/500px-Fronalpstock_big.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Camponotus_flavomarginatus_ant.jpg/500px-Camponotus_flavomarginatus_ant.jpg',
] as const

/** A marketing mail as a sender's template writes it: a table layout with inline styles. */
const NEWSLETTER_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Spring newsletter</title></head>
<body style="margin:0;padding:0;background-color:whitesmoke;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:whitesmoke;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:white;border-radius:6px;">
        <tr>
          <td style="background-color:darkgreen;color:white;padding:20px 28px;font-size:22px;font-weight:bold;border-radius:6px 6px 0 0;">
            Garden Supply &middot; Spring newsletter
          </td>
        </tr>
        <tr>
          <td style="padding:0;">
            <img src="${FIXTURE_NEWSLETTER_IMAGES[0]}" width="600" alt="Mountain meadow in spring" style="display:block;width:100%;height:auto;">
          </td>
        </tr>
        <tr>
          <td style="padding:24px 28px;color:darkslategray;font-size:15px;line-height:1.5;">
            <p style="margin:0 0 16px;">New arrivals for the season are in: seed trays, hand tools and raised beds. This week everything in the spring range is 20% off.</p>
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background-color:darkorange;border-radius:4px;">
                  <a href="https://example.com/offers?utm_source=newsletter&amp;utm_medium=email" style="display:inline-block;padding:12px 22px;color:white;font-weight:bold;text-decoration:none;">See the offers</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 24px;">
            <img alt="A close look at the garden" src='${FIXTURE_NEWSLETTER_IMAGES[1]}' width="260" style="display:block;border-radius:4px;">
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px;background-color:gainsboro;color:dimgray;font-size:12px;">
            You receive this mail because you signed up at our shop. <a href="https://example.com/unsubscribe" style="color:dimgray;">Unsubscribe</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

/** A reply written in a mail program's HTML editor: plain blocks, no colours. */
const INTERVIEW_HTML = `<div>Hi,</div>
<div><br></div>
<div>Thursday at 10:00 works for the team lead. Would that suit you? The interview takes about an hour, at our office.</div>
<div><br></div>
<div>The route and parking are on <a href="https://talent.example/visit">our visitor page</a>.</div>
<div><br></div>
<div>Kind regards,<br>Nora Example</div>`

/** Gmail-shaped thread ids, so a send path that needs one finds one. */
export const FIXTURE_THREAD = {
  interview: '1790000000000000001',
  parking: '1790000000000000002',
  waiting: '1790000000000000003',
  digest: '1790000000000000004',
  family: '1790000000000000005',
  application: '1790000000000000006',
  newsletter: '1790000000000000007',
  result: '1790000000000000008',
  receipt: '1790000000000000009',
  signUp: '1790000000000000010',
} as const

/**
 * Ten threads modelled on the design's Inbox; `now` anchors their times. Two carry HTML,
 * the rest plain text only. The last three are automatic mail that still matters: a
 * result waiting in a patient portal, a receipt and a sign-up confirmation.
 */
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
      threadId: FIXTURE_THREAD.signUp,
      subject: 'Jouw aanmelding bij Swim School',
      from: swimSchool,
      to: [ACCOUNT],
      at: now - 46 * HOUR,
      seen: true,
      inbox: true,
      text: 'Bedankt voor je aanmelding!\n\nJe staat ingeschreven voor de cursus van het voorjaar. De eerste les is op zaterdag 6 maart om 09:00. Neem je inschrijfnummer 4471 mee.\n\nTot dan,\nSwim School',
    }),
    message({
      threadId: FIXTURE_THREAD.receipt,
      subject: 'Your receipt for order 1042',
      from: bikeShop,
      to: [ACCOUNT],
      at: now - 44 * HOUR,
      seen: true,
      inbox: true,
      text: 'Thank you for your order.\n\nOrder 1042\n1 x Rear light, 24.95\nShipping, 4.95\nTotal paid, 29.90\n\nKeep this mail as your proof of purchase.',
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
      threadId: FIXTURE_THREAD.newsletter,
      subject: 'Spring newsletter: new arrivals and 20% off',
      from: shop,
      to: [ACCOUNT],
      at: now - 14 * HOUR,
      seen: false,
      inbox: true,
      text: 'Garden Supply - Spring newsletter\n\nNew arrivals for the season are in: seed trays, hand tools and raised beds. This week everything in the spring range is 20% off.\n\nSee the offers: https://example.com/offers\n\nYou receive this mail because you signed up at our shop. Unsubscribe: https://example.com/unsubscribe',
      html: NEWSLETTER_HTML,
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
      threadId: FIXTURE_THREAD.result,
      subject: 'Uitslag onderzoek beschikbaar in het patiëntenportaal',
      from: hospital,
      to: [ACCOUNT],
      at: now - 6 * HOUR,
      seen: false,
      inbox: true,
      text: 'Geachte heer, mevrouw,\n\nEr staat een nieuwe uitslag van een onderzoek voor u klaar in het patiëntenportaal. Log in om de uitslag te bekijken.\n\nDit is een automatisch bericht, u kunt hier niet op antwoorden.',
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
      text: 'Hi,\n\nThursday at 10:00 works for the team lead. Would that suit you? The interview takes about an hour, at our office.\n\nThe route and parking are on our visitor page: https://talent.example/visit\n\nKind regards,\nNora Example',
      html: INTERVIEW_HTML,
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
        ...(message.html === undefined ? {} : { html: message.html }),
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
