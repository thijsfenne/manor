import { describe, expect, it, vi } from 'vitest'
import { OutboundDrafts, sentConfirmation } from '../src/outboundDrafts.js'
import { executeComposioTool } from '../src/mcp/composioRegistration.js'
import { ConfirmedOutboundSend, type ComposioOutbound, type OutboundRoute, type OutboundSendPort, type OutboundSendRequest, type OutboundSendResult } from '../src/outboundSend.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

async function chatStore() {
  const store = createMemoryStore()
  const [project] = await store.listProjects()
  const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
  return { store, chatId: chat.id }
}

const gmail = { channel: 'gmail' as const, to: 'info@example.com', subject: 'Portfolio', body: 'Here it is.' }

/** A send port whose answer and route the test sets. */
function port(result: OutboundSendResult, ...route: [OutboundRoute | undefined] | []): OutboundSendPort {
  const resolved = route.length === 0 ? { kind: 'native' as const } : route[0]
  return { send: async () => result, route: async () => resolved }
}

describe('sent confirmation', () => {
  it('adds the persona reply under the card after a confirmed delivery', async () => {
    const { store, chatId } = await chatStore()
    const drafts = new OutboundDrafts({ store, send: port({ ok: true, delivery: 'delivered' }), emit: () => undefined })
    const { draftId } = await drafts.record(chatId, 'marlow', 'turn_1', gmail)

    expect(await drafts.submit(chatId, draftId, 'Here it is.')).toBe(true)
    const events = await store.loadEvents(chatId)
    expect(events.map((event) => event.type)).toEqual(['outbound_draft', 'outbound_draft_submission', 'outbound_draft_submission', 'agent_message'])
    expect(events.at(-1)).toMatchObject({ type: 'agent_message', agentId: 'marlow', turnId: 'turn_1', text: sentConfirmation(gmail) })
  })

  for (const [label, result] of [
    ['an uncertain outcome', { ok: false, certainty: 'uncertain', message: 'connection dropped' }],
    ['a safe failure', { ok: false, certainty: 'safe', message: 'refused' }],
    ['a recorded test send', { ok: true, delivery: 'recorded' }],
  ] as const) {
    it(`says nothing after ${label}`, async () => {
      const { store, chatId } = await chatStore()
      const drafts = new OutboundDrafts({ store, send: port(result), emit: () => undefined })
      const { draftId } = await drafts.record(chatId, 'marlow', 'turn_1', gmail)
      await drafts.submit(chatId, draftId, 'Here it is.')
      expect((await store.loadEvents(chatId)).some((event) => event.type === 'agent_message')).toBe(false)
    })
  }
})

describe('connect card before a draft', () => {
  const context = { chatId: '', agentId: 'marlow', turnId: 'turn_1' }

  it('lands the draft at once with its sender when the channel can send', async () => {
    const { store, chatId } = await chatStore()
    const connect = vi.fn()
    const drafts = new OutboundDrafts({ store, send: port({ ok: true, delivery: 'delivered' }, { kind: 'native', from: 'me@example.com' }), emit: () => undefined, connect })
    const result = await drafts.prepare({ ...context, chatId }, gmail)
    expect(result).toHaveProperty('draftId')
    expect(connect).not.toHaveBeenCalled()
    expect((await store.loadEvents(chatId))[0]).toMatchObject({ type: 'outbound_draft', from: 'me@example.com' })
  })

  it('shows a connect card and adds no draft while the sign-in is pending', async () => {
    const { store, chatId } = await chatStore()
    const connect = vi.fn(async () => ({ status: 'pending' as const }))
    const drafts = new OutboundDrafts({ store, send: port({ ok: true, delivery: 'delivered' }, undefined), emit: () => undefined, connect })
    expect(await drafts.prepare({ ...context, chatId }, { channel: 'slack', to: '#general', body: 'Hi', slackChannelId: 'C0MOCK0001' }))
      .toEqual({ notConnected: 'pending' })
    expect(connect).toHaveBeenCalledWith({ ...context, chatId }, 'slack', expect.any(Function))
    expect(await store.loadEvents(chatId)).toEqual([])
  })

  it('adds the draft in the same call once the card reports connected', async () => {
    const { store, chatId } = await chatStore()
    let connected = false
    const send = { send: async () => ({ ok: true, delivery: 'delivered' } as const), route: async (): Promise<OutboundRoute | undefined> => connected ? { kind: 'composio', accountId: 'ca_1', from: 'new@example.com' } : undefined }
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined, connect: async () => { connected = true; return { status: 'connected' } } })
    expect(await drafts.prepare({ ...context, chatId }, gmail)).toHaveProperty('draftId')
    expect((await store.loadEvents(chatId))[0]).toMatchObject({ type: 'outbound_draft', from: 'new@example.com' })
  })

  it('never shows a card in an unattended turn, and reports a host that cannot offer one', async () => {
    const { store, chatId } = await chatStore()
    const connect = vi.fn(async () => ({ status: 'pending' as const }))
    const drafts = new OutboundDrafts({ store, send: port({ ok: true, delivery: 'delivered' }, undefined), emit: () => undefined, connect })
    expect(await drafts.prepare({ ...context, chatId, canApprove: false }, gmail)).toEqual({ notConnected: 'unavailable' })
    expect(connect).not.toHaveBeenCalled()
    const bare = new OutboundDrafts({ store, send: port({ ok: true, delivery: 'delivered' }, undefined), emit: () => undefined })
    expect(await bare.prepare({ ...context, chatId }, gmail)).toEqual({ notConnected: 'unavailable' })
  })

  it('gives up inside the tool call budget and records nothing after it', async () => {
    const { store, chatId } = await chatStore()
    const drafts = new OutboundDrafts({ store, send: port({ ok: true, delivery: 'delivered' }, undefined), emit: () => undefined, connect: () => new Promise(() => undefined), prepareBudgetMs: 20 })
    expect(await drafts.prepare({ ...context, chatId }, gmail)).toEqual({ notConnected: 'failed', reason: 'connecting took too long' })
    expect(await store.loadEvents(chatId)).toEqual([])
  })

  it('starts no connect card when the first lookup answers after the deadline', async () => {
    const { store, chatId } = await chatStore()
    let answer: (route: undefined) => void = () => undefined
    const connect = vi.fn(async () => ({ status: 'pending' as const }))
    const send = { send: async () => ({ ok: true, delivery: 'delivered' } as const), route: () => new Promise<undefined>((resolve) => { answer = resolve }) }
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined, connect, prepareBudgetMs: 20 })
    expect(await drafts.prepare({ ...context, chatId }, gmail)).toEqual({ notConnected: 'failed', reason: 'connecting took too long' })
    answer(undefined)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connect).not.toHaveBeenCalled()
  })
})

describe('sending through Composio', () => {
  const noSlack = async () => { throw new Error('no Slack session') }
  function composio(answer: Awaited<ReturnType<ComposioOutbound['execute']>> = { status: 'ok', data: {} }) {
    const calls: { slug: string; args: Record<string, unknown> }[] = []
    const outbound: ComposioOutbound = {
      available: () => true,
      account: async () => 'ca_gmail',
      execute: async (slug, _account, args) => {
        calls.push({ slug, args })
        return slug === 'GMAIL_GET_PROFILE' ? { status: 'ok', data: { emailAddress: 'me@example.com' } } : answer
      },
    }
    return { outbound, calls }
  }
  const sender = (outbound: ComposioOutbound) =>
    new ConfirmedOutboundSend({}, () => { throw new Error('no SMTP here') }, noSlack, fetch, async () => { throw new Error('no IMAP') }, outbound)

  it('routes Gmail to the Composio account without host credentials, with its address', async () => {
    const { outbound } = composio()
    expect(await sender(outbound).route('gmail')).toEqual({ kind: 'composio', accountId: 'ca_gmail', from: 'me@example.com' })
  })

  it('sends new mail with Cc and replies by thread id, signature off', async () => {
    const { outbound, calls } = composio()
    const send = sender(outbound)
    expect(await send.send({ channel: 'gmail', to: 'Ada <ada@example.com>', cc: 'sam@example.com, kim@example.com', from: 'me@example.com', subject: 'Hi', body: 'Body', submissionId: 's1' }))
      .toEqual({ ok: true, delivery: 'delivered' })
    expect(await send.send({ channel: 'gmail', to: 'ada@example.com', from: 'me@example.com', body: 'Reply', gmailThreadId: '18c2f0a9d4e1b7c3', submissionId: 's2' }))
      .toEqual({ ok: true, delivery: 'delivered' })
    expect(calls.filter((call) => call.slug !== 'GMAIL_GET_PROFILE')).toEqual([
      { slug: 'GMAIL_SEND_EMAIL', args: { recipient_email: 'ada@example.com', cc: ['sam@example.com', 'kim@example.com'], include_signature: false, is_html: false, subject: 'Hi', body: 'Body' } },
      { slug: 'GMAIL_REPLY_TO_THREAD', args: { recipient_email: 'ada@example.com', cc: [], include_signature: false, is_html: false, thread_id: '18c2f0a9d4e1b7c3', message_body: 'Reply' } },
    ])
  })

  it('locks an unconfirmed Composio send as uncertain and reopens only a refusal', async () => {
    const unknown = sender(composio({ status: 'unknown', message: 'timeout' }).outbound)
    expect(await unknown.send({ channel: 'gmail', to: 'ada@example.com', from: 'me@example.com', body: 'x', submissionId: 's' })).toMatchObject({ ok: false, certainty: 'uncertain' })
    const refused = sender(composio({ status: 'refused', message: '400' }).outbound)
    expect(await refused.send({ channel: 'gmail', to: 'ada@example.com', from: 'me@example.com', body: 'x', submissionId: 's' })).toMatchObject({ ok: false, certainty: 'safe' })
  })

  it('refuses to send from another account than the card showed', async () => {
    const { outbound, calls } = composio()
    expect(await sender(outbound).send({ channel: 'gmail', to: 'ada@example.com', from: 'old@example.com', body: 'x', submissionId: 's' }))
      .toMatchObject({ ok: false, certainty: 'safe', message: expect.stringContaining('no longer old@example.com') })
    expect(calls.map((call) => call.slug)).toEqual(['GMAIL_GET_PROFILE'])
    expect(await sender(outbound).send({ channel: 'gmail', to: 'ada@example.com', from: 'Me <ME@example.com>', body: 'x', submissionId: 's' }))
      .toEqual({ ok: true, delivery: 'delivered' })
  })

  it('sends nothing from a card that never named its sender', async () => {
    const { outbound, calls } = composio()
    expect(await sender(outbound).send({ channel: 'gmail', to: 'ada@example.com', body: 'x', submissionId: 's' }))
      .toMatchObject({ ok: false, certainty: 'safe' })
    expect(calls).toEqual([])
  })

  it('adds no Gmail card when the account address cannot be read', async () => {
    const { store, chatId } = await chatStore()
    const unreadable: ComposioOutbound = { ...composio().outbound, execute: async () => ({ status: 'unknown', message: 'timeout' }) }
    const drafts = new OutboundDrafts({ store, send: sender(unreadable), emit: () => undefined })
    expect(await drafts.prepare({ chatId, agentId: 'marlow', turnId: 'turn_1' }, gmail))
      .toEqual({ notConnected: 'failed', reason: 'the Gmail address could not be read' })
    expect(await store.loadEvents(chatId)).toEqual([])
  })

  it('refuses a bad Cc line before anything leaves', async () => {
    const { outbound, calls } = composio()
    expect(await sender(outbound).send({ channel: 'gmail', to: 'ada@example.com', cc: 'not an address', body: 'x', submissionId: 's' }))
      .toMatchObject({ ok: false, certainty: 'safe' })
    expect(calls).toEqual([])
  })
})

describe('Composio answers', () => {
  const answer = (status: number) => executeComposioTool('key', 'GMAIL_SEND_EMAIL', 'ca_1', {}, async () => new Response('{}', { status }))

  it('reopens a send only on a refusal that comes before the tool runs', async () => {
    for (const status of [401, 403, 404, 422]) expect((await answer(status)).status).toBe('refused')
    for (const status of [400, 408, 409, 429, 500, 504]) expect((await answer(status)).status).toBe('unknown')
  })
})

describe('a Gmail reply', () => {
  const thread = { threadId: '18c2f0a9d4e1b7c3', previous: { from: 'Sam', at: '2026-11-12T10:00:00.000Z', text: 'Question' }, earlierCount: 0 }
  const reply = { ...gmail, subject: 'Re: Portfolio', thread }
  const routed = (kind: 'native' | 'composio') => {
    const sent: OutboundSendRequest[] = []
    const send = {
      send: async (request: OutboundSendRequest) => { sent.push(request); return { ok: true, delivery: 'delivered' } as const },
      route: async (): Promise<OutboundRoute> => kind === 'native' ? { kind, from: 'me@example.com' } : { kind, accountId: 'ca_1', from: 'me@example.com' },
    }
    return { send, sent }
  }

  it('keeps its thread subject whatever the client sends', async () => {
    const { store, chatId } = await chatStore()
    const { send, sent } = routed('native')
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined })
    const result = await drafts.prepare({ chatId, agentId: 'marlow', turnId: 'turn_1' }, reply)
    expect(await drafts.submit(chatId, (result as { draftId: string }).draftId, 'Body', 'A new title')).toBe(true)
    expect(sent[0]?.subject).toBe('Re: Portfolio')
  })

  it('offers the full thread only where the host mailbox can read it', async () => {
    for (const [kind, expected] of [['native', undefined], ['composio', false]] as const) {
      const { store, chatId } = await chatStore()
      const drafts = new OutboundDrafts({ store, send: routed(kind).send, emit: () => undefined })
      await drafts.prepare({ chatId, agentId: 'marlow', turnId: 'turn_1' }, reply)
      const [event] = await store.loadEvents(chatId)
      expect(event?.type === 'outbound_draft' ? event.fullThread : 'missing').toBe(expected)
    }
  })
})

describe('sending over the host mailbox', () => {
  it('never calls a partly refused mail delivered', async () => {
    const sendMail = vi.fn(async () => ({ accepted: ['copy@example.com'], rejected: ['to@example.com'] }))
    const send = new ConfirmedOutboundSend({ MANOR_MAIL_IMAP_USER: 'me@example.com', MANOR_MAIL_IMAP_PASSWORD: 'x' }, () => ({ sendMail }))
    expect(await send.send({ channel: 'gmail', to: 'to@example.com', cc: 'copy@example.com', body: 'x', submissionId: 's' }))
      .toMatchObject({ ok: false, certainty: 'uncertain', message: expect.stringContaining('to@example.com') })
  })
})
