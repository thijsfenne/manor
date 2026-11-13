import { describe, expect, it, vi } from 'vitest'
import { ConfirmedOutboundSend } from '../src/outboundSend.js'

const credentials = {
  MANOR_MAIL_IMAP_USER: 'sam@example.invalid',
  MANOR_MAIL_IMAP_PASSWORD: 'app-password',
}
const submissionId = '11111111-1111-4111-8111-111111111111'

describe('Gmail outbound send', () => {
  it('delivers the confirmed draft through the personal Gmail account', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'sent-1' })
    const transport = vi.fn(() => ({ sendMail }))
    const send = new ConfirmedOutboundSend(credentials, transport)

    await expect(send.send({
      channel: 'gmail',
      to: 'Robin <robin@example.invalid>',
      subject: 'Hello',
      body: 'Confirmed body',
      submissionId,
    })).resolves.toEqual({ ok: true, delivery: 'delivered' })

    expect(transport).toHaveBeenCalledWith({
      service: 'gmail',
      auth: { user: 'sam@example.invalid', pass: 'app-password' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    })
    expect(sendMail).toHaveBeenCalledOnce()
    expect(sendMail).toHaveBeenCalledWith({
      from: 'sam@example.invalid',
      to: 'Robin <robin@example.invalid>',
      subject: 'Hello',
      text: 'Confirmed body',
      messageId: `<${submissionId}@manor.local>`,
    })
  })

  it('threads a reply card into its Gmail conversation without a lookup for new mail', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'sent-reply' })
    const reply = vi.fn().mockResolvedValue({
      inReplyTo: '<latest@example.invalid>',
      references: ['<root@example.invalid>', '<latest@example.invalid>'],
    })
    const send = new ConfirmedOutboundSend(credentials, () => ({ sendMail }), undefined, undefined, reply)

    await expect(send.send({
      channel: 'gmail',
      mailAccount: 'personal',
      gmailThreadId: '1a11577524273408',
      to: 'Sam Example <sam@example.invalid>',
      subject: 'Update on your application status @ Creative Fabrica',
      body: 'Thanks for the update.',
      submissionId,
    })).resolves.toEqual({ ok: true, delivery: 'delivered' })
    expect(reply).toHaveBeenCalledWith('1a11577524273408')
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Update on your application status @ Creative Fabrica',
      inReplyTo: '<latest@example.invalid>',
      references: ['<root@example.invalid>', '<latest@example.invalid>'],
    }))

    await send.send({ channel: 'gmail', to: 'ada@example.com', subject: 'New', body: 'Hello', submissionId })
    expect(reply).toHaveBeenCalledOnce()
    expect(sendMail.mock.calls[1]?.[0]).not.toHaveProperty('inReplyTo')
    expect(sendMail.mock.calls[1]?.[0]).not.toHaveProperty('references')
  })

  it('refuses a reply safely, before SMTP, when its thread cannot be read', async () => {
    const transport = vi.fn()
    const reply = vi.fn().mockRejectedValue(new Error('the original email thread is no longer in the mailbox'))
    const send = new ConfirmedOutboundSend(credentials, transport, undefined, undefined, reply)

    await expect(send.send({
      channel: 'gmail',
      mailAccount: 'personal',
      gmailThreadId: '1901234567890123456',
      to: 'client@example.com',
      body: 'Reply',
      submissionId,
    })).resolves.toEqual({
      ok: false,
      certainty: 'safe',
      message: 'Gmail did not send this reply because the original thread could not be read: the original email thread is no longer in the mailbox',
    })
    expect(reply).toHaveBeenCalledWith('1901234567890123456')
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses Gmail when the personal mail credentials are absent', async () => {
    const transport = vi.fn()
    const send = new ConfirmedOutboundSend({}, transport)

    await expect(send.send({
      channel: 'gmail',
      to: 'robin@example.invalid',
      body: 'Hello',
      submissionId,
    })).resolves.toEqual({
      ok: false,
      certainty: 'safe',
      message: 'Gmail sending is unavailable because the personal mail connection is not configured.',
    })
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses a recipient that could inject another mail header', async () => {
    const transport = vi.fn()
    const send = new ConfirmedOutboundSend(credentials, transport)

    const result = await send.send({
      channel: 'gmail',
      to: 'robin@example.invalid\r\nBcc: stranger@example.com',
      body: 'Hello',
      submissionId,
    })

    expect(result.ok).toBe(false)
    expect(transport).not.toHaveBeenCalled()
  })

  it('leaves failed SMTP delivery open for retry', async () => {
    const send = new ConfirmedOutboundSend(credentials, () => ({
      sendMail: vi.fn().mockRejectedValue(new Error('authentication failed')),
    }))

    await expect(send.send({
      channel: 'gmail',
      to: 'robin@example.invalid',
      body: 'Hello',
      submissionId,
    })).resolves.toEqual({
      ok: false,
      certainty: 'uncertain',
      message: 'Gmail could not send this draft: authentication failed',
    })
  })

  it('delivers a confirmed Slack thread reply to the exact conversation', async () => {
    const transport = vi.fn()
    const slackFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ts: '1234567890.123456' }),
    })
    const send = new ConfirmedOutboundSend(
      credentials,
      transport,
      async () => ({ token: 'test-token', cookie: 'test-cookie' }),
      slackFetch,
    )

    await expect(send.send({
      channel: 'slack',
      to: '#general',
      slackChannelId: 'C044BJUQ60T',
      slackThreadTs: '1234567890.123456',
      body: 'Hello',
      submissionId,
    })).resolves.toEqual({ ok: true, delivery: 'delivered' })

    expect(slackFetch).toHaveBeenCalledOnce()
    const [url, init] = slackFetch.mock.calls[0]!
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        cookie: 'd=test-cookie',
        'content-type': 'application/x-www-form-urlencoded',
      },
    })
    expect(new URLSearchParams(String(init.body))).toEqual(new URLSearchParams({
      channel: 'C044BJUQ60T',
      text: 'Hello',
      client_msg_id: submissionId,
      thread_ts: '1234567890.123456',
    }))
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses Slack without a conversation id before reading credentials', async () => {
    const loadCredentials = vi.fn()
    const send = new ConfirmedOutboundSend(credentials, vi.fn(), loadCredentials)

    await expect(send.send({
      channel: 'slack',
      to: '#general',
      body: 'Hello',
      submissionId,
    })).resolves.toEqual({
      ok: false,
      certainty: 'safe',
      message: 'Slack could not send this draft because it has no valid conversation id.',
    })
    expect(loadCredentials).not.toHaveBeenCalled()
  })

  it('keeps a Slack API refusal open for retry', async () => {
    const send = new ConfirmedOutboundSend(
      credentials,
      vi.fn(),
      async () => ({ token: 'test-token', cookie: 'test-cookie' }),
      async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'invalid_auth' }) }),
    )

    await expect(send.send({
      channel: 'slack',
      to: '#general',
      slackChannelId: 'C044BJUQ60T',
      body: 'Hello',
      submissionId,
    })).resolves.toEqual({ ok: false, certainty: 'safe', message: 'Slack could not send this draft: invalid_auth' })
  })
})


it('posts native Slack lists and styles with a derived notification fallback', async () => {
  const slackFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  const send = new ConfirmedOutboundSend({}, vi.fn(), async () => ({ token: 'test', cookie: 'test' }), slackFetch)
  const slackRichText = {
    type: 'rich_text' as const,
    elements: [{ type: 'rich_text_list' as const, style: 'ordered' as const, elements: [
      { type: 'rich_text_section' as const, elements: [{ type: 'text' as const, text: 'Approved', style: { bold: true } }] },
    ] }],
  }
  expect(await send.send({ channel: 'slack', to: 'Self', slackChannelId: 'D12345678', body: 'Stale fallback', slackRichText, submissionId })).toEqual({ ok: true, delivery: 'delivered' })
  const form = new URLSearchParams(String(slackFetch.mock.calls[0]![1].body))
  expect(JSON.parse(form.get('blocks')!)).toEqual([slackRichText])
  expect(form.get('text')).toBe('1. Approved')
  expect(form.get('mrkdwn')).toBe('false')
  expect(form.get('parse')).toBe('none')
  expect(form.get('client_msg_id')).toBe(submissionId)
})

it('refuses invalid rich text before credentials or external IO', async () => {
  const credentials = vi.fn()
  const send = new ConfirmedOutboundSend({}, vi.fn(), credentials)
  expect(await send.send({ channel: 'slack', to: 'Self', slackChannelId: 'D12345678', body: 'Hi', slackRichText: { type: 'rich_text', elements: [] }, submissionId })).toMatchObject({ ok: false, certainty: 'safe' })
  expect(credentials).not.toHaveBeenCalled()
})

it('posts mentions as Slack user elements, never as literal text', async () => {
  const slackFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  const send = new ConfirmedOutboundSend({}, vi.fn(), async () => ({ token: 'test', cookie: 'test' }), slackFetch)
  const slackRichText = { type: 'rich_text' as const, elements: [{ type: 'rich_text_section' as const, elements: [
    { type: 'text' as const, text: '<@U053J6TH7RN> about ' },
    { type: 'user' as const, user_id: 'U0SANDER1', name: 'Sander' },
  ] }] }
  expect(await send.send({ channel: 'slack', to: 'Self', slackChannelId: 'C08QE869K8V', body: 'x', slackRichText, submissionId })).toEqual({ ok: true, delivery: 'delivered' })
  const form = new URLSearchParams(String(slackFetch.mock.calls[0]![1].body))
  expect(JSON.parse(form.get('blocks')!)[0].elements[0].elements).toEqual([
    { type: 'user', user_id: 'U053J6TH7RN' },
    { type: 'text', text: ' about ' },
    { type: 'user', user_id: 'U0SANDER1' },
  ])
  expect(form.get('text')).toBe('@U053J6TH7RN about @Sander')
})
