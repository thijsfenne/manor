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
      slackChannelId: 'C0MOCK0001',
    })
  })

  it('reads a threaded gmail reply with a Cc line', () => {
    expect(parseOutboundDraftIntent('draft gmail reply to info@example.com cc sam@example.com: Here it is')).toMatchObject({
      channel: 'gmail',
      to: 'info@example.com',
      cc: 'sam@example.com',
      body: 'Here it is',
      thread: { threadId: '18c2f0a9d4e1b7c3', earlierCount: 2 },
    })
  })
})
