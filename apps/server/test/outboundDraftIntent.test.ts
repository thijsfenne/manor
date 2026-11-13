import { describe, expect, it } from 'vitest'
import { parseOutboundDraftIntent } from '../src/outboundDraftIntent.js'

describe('parseOutboundDraftIntent', () => {
  it('reads a gmail draft with a recipient and body', () => {
    expect(parseOutboundDraftIntent('Draft a gmail to ada@example.com: Hello **Ada**')).toEqual({
      channel: 'gmail',
      to: 'ada@example.com',
      subject: 'Draft from Manor',
      body: 'Hello **Ada**',
    })
  })

  it('reads a slack draft', () => {
    expect(parseOutboundDraftIntent('draft slack to #general: standup notes')).toEqual({
      channel: 'slack',
      to: '#general',
      body: 'standup notes',
    })
  })
})
