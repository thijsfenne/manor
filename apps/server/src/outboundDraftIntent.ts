import type { OutboundChannel } from '@manor/contracts'

export interface OutboundDraftIntent {
  channel: OutboundChannel
  to: string
  subject?: string
  body: string
}

/**
 * Spike/mock trigger. Real personas use prepare_outbound_draft; this is how the
 * mock driver puts a draft in the bubble without a live connector.
 */
export function parseOutboundDraftIntent(text: string): OutboundDraftIntent | undefined {
  const match = /draft(?: a)? (gmail|email|slack)(?: to ([^:\n]+))?(?::\s*([\s\S]+))?/i.exec(text)
  if (match === null) return undefined
  const channel: OutboundChannel = match[1]?.toLowerCase() === 'slack' ? 'slack' : 'gmail'
  const to = match[2]?.trim() || (channel === 'slack' ? '#general' : 'recipient@example.com')
  const body = match[3]?.trim() || 'Hello from Manor.'
  return channel === 'gmail'
    ? { channel, to, subject: 'Draft from Manor', body }
    : { channel, to, body }
}
