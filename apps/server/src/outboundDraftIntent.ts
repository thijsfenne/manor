import type { OutboundDraftContent } from '@manor/contracts'

/** A fixed earlier message, so the spike can show a threaded draft without a mailbox. */
const mockThread = (from: string) => ({
  threadId: '18c2f0a9d4e1b7c3',
  previous: {
    from,
    at: '2026-11-12T15:42:00.000Z',
    text: 'Thanks for applying. Could you send your portfolio link before Friday? We would like to look at it ahead of the first call.',
  },
  earlierCount: 2,
})

/**
 * Spike/mock trigger. Real personas use prepare_outbound_draft; this is how the mock
 * driver puts a draft in the chat without a live connector. Grammar:
 * `draft gmail|email|slack [reply] [to <who>] [cc <who>]: <body>`.
 */
export function parseOutboundDraftIntent(text: string): OutboundDraftContent | undefined {
  const match = /draft(?: a)? (gmail|email|slack)( reply)?(?: to ([^:\n]+?))?(?: cc ([^:\n]+?))?(?::\s*([\s\S]+))?$/im.exec(text)
  if (match === null) return undefined
  const slack = match[1]?.toLowerCase() === 'slack'
  const reply = match[2] !== undefined
  const to = match[3]?.trim() || (slack ? '#general' : 'recipient@example.com')
  const body = match[5]?.trim() || 'Hello from Manor.'
  if (slack) {
    return {
      channel: 'slack',
      to,
      body,
      slackChannelId: 'C0MOCK0001',
      ...(reply ? { slackThreadTs: '1731422520.000100', thread: mockThread('Sam Rivera') } : {}),
    }
  }
  const cc = match[4]?.trim()
  return {
    channel: 'gmail',
    to,
    subject: reply ? 'Re: Product Engineer UI/UX' : 'Draft from Manor',
    body,
    ...(cc === undefined || cc === '' ? {} : { cc }),
    ...(reply ? { thread: mockThread(to) } : {}),
  }
}
