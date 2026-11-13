import { describe, expect, it } from 'vitest'
import { OutboundDrafts } from '../src/outboundDrafts.js'
import { RecordingOutboundSend } from '../src/outboundSend.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

describe('outbound drafts', () => {
  const thread = {
    threadId: '1901234567890123456',
    previous: { from: 'Ada <ada@example.com>', at: '2026-09-01T08:00:00.000Z', text: 'Can you reply?' },
    earlierCount: 2,
    openUrl: 'https://mail.google.com/mail/u/?authuser=me%40example.com#all/1a',
  }

  it('keeps the typed Gmail route and nested thread inert until Submit', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const send = new RecordingOutboundSend()
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined })

    const recorded = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail',
      to: 'client@example.com',
      subject: 'Re: Project',
      body: 'Prepared reply',
      mailAccount: 'personal',
      thread,
    })
    if (!('draftId' in recorded)) throw new Error('expected a draft')
    const { draftId } = recorded

    expect(send.sent).toEqual([])
    expect((await store.loadEvents(chat.id))[0]).toMatchObject({
      type: 'outbound_draft',
      draftId,
      to: 'client@example.com',
      mailAccount: 'personal',
      thread,
    })

    expect(await drafts.submit(chat.id, draftId, 'Confirmed reply')).toBe(true)
    expect(send.sent).toEqual([expect.objectContaining({
      to: 'client@example.com',
      mailAccount: 'personal',
      gmailThreadId: thread.threadId,
      body: 'Confirmed reply',
    })])
  })

  it('submits the edited body to the send port and refuses a second submit', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const send = new RecordingOutboundSend()
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined })

    const { draftId } = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail',
      to: 'ada@example.com',
      subject: 'Hello',
      body: 'Original **markdown**',
    })
    expect(await drafts.submit(chat.id, draftId, '\nEdited plain body\n', '')).toBe(true)
    expect(send.sent).toEqual([expect.objectContaining({
      channel: 'gmail',
      to: 'ada@example.com',
      mailAccount: 'personal',
      body: '\nEdited plain body\n',
      submissionId: expect.any(String),
    })])
    expect(send.sent[0]).not.toHaveProperty('gmailThreadId')
    expect(await drafts.submit(chat.id, draftId, 'Again')).toBe(false)
    expect(send.sent).toHaveLength(1)

    const events = await store.loadEvents(chat.id)
    expect(events.filter((event) => event.type === 'outbound_draft_submission')).toEqual([
      expect.objectContaining({
        type: 'outbound_draft_submission',
        draftId,
        status: 'started',
        body: '\nEdited plain body\n',
      }),
      expect.objectContaining({ status: 'delivered', delivery: 'recorded', draftId }),
    ])
  })

  it('discard never calls send', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const send = new RecordingOutboundSend()
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined })
    const { draftId } = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'slack',
      to: '#general',
      slackChannelId: 'C044BJUQ60T',
      body: 'Hold this',
    })
    expect((await store.loadEvents(chat.id))[0]).not.toHaveProperty('subject')
    expect(await drafts.discard(chat.id, draftId)).toBe(true)
    expect(send.sent).toEqual([])
    expect(await drafts.submit(chat.id, draftId, 'Nope')).toBe(false)
  })

  it('allows only one concurrent close', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    const sent: unknown[] = []
    const drafts = new OutboundDrafts({
      store,
      send: {
        async send(request) {
          sent.push(request)
          await blocked
          return { ok: true, delivery: 'recorded' }
        },
      },
      emit: () => undefined,
    })
    const { draftId } = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'slack',
      to: '#general',
      slackChannelId: 'C044BJUQ60T',
      body: 'Original',
    })

    const first = drafts.submit(chat.id, draftId, 'Edited', 'Ignored')
    expect(await drafts.submit(chat.id, draftId, 'Duplicate')).toBe(false)
    expect(await drafts.discard(chat.id, draftId)).toBe(false)
    release()

    await expect(first).resolves.toBe(true)
    expect(sent).toEqual([expect.objectContaining({
      channel: 'slack',
      to: '#general',
      slackChannelId: 'C044BJUQ60T',
      body: 'Edited',
      submissionId: expect.any(String),
    })])
  })

  it('never sends again when delivery succeeded but recording it failed', async () => {
    const backing = createMemoryStore()
    const [project] = await backing.listProjects()
    const chat = await backing.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    let failDeliveryRecord = true
    const store = {
      loadEvents: (chatId: string) => backing.loadEvents(chatId),
      listUnresolvedOutboundSubmissions: () => backing.listUnresolvedOutboundSubmissions(),
      getOutboundThreadDecision: (key: Parameters<typeof backing.getOutboundThreadDecision>[0]) =>
        backing.getOutboundThreadDecision(key),
      saveOutboundThreadDecision: (
        key: Parameters<typeof backing.saveOutboundThreadDecision>[0],
        decision: Parameters<typeof backing.saveOutboundThreadDecision>[1],
      ) => backing.saveOutboundThreadDecision(key, decision),
      deleteOutboundThreadDecision: (key: Parameters<typeof backing.deleteOutboundThreadDecision>[0]) =>
        backing.deleteOutboundThreadDecision(key),
      appendEvent: async (chatId: string, draft: Parameters<typeof backing.appendEvent>[1]) => {
        if (draft.type === 'outbound_draft_submission' && draft.status === 'delivered' && failDeliveryRecord) {
          failDeliveryRecord = false
          throw new Error('store unavailable after provider acceptance')
        }
        return backing.appendEvent(chatId, draft)
      },
    }
    const send = new RecordingOutboundSend()
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined })
    const { draftId } = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail',
      to: 'ada@example.com',
      body: 'Original',
    })

    await expect(drafts.submit(chat.id, draftId, 'Edited')).rejects.toThrow('store unavailable')
    await expect(drafts.submit(chat.id, draftId, 'Retry')).resolves.toBe(false)
    expect(send.sent).toHaveLength(1)
    expect((await backing.loadEvents(chat.id)).at(-1)).toMatchObject({
      type: 'outbound_draft_submission',
      status: 'started',
      draftId,
    })
  })

  it('marks claims left by a previous server process as uncertain on startup', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const send = new RecordingOutboundSend()
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined })
    const { draftId } = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail',
      to: 'ada@example.com',
      body: 'Original',
    })
    await store.appendEvent(chat.id, {
      type: 'outbound_draft_submission',
      agentId: 'marlow',
      turnId: 'turn_1',
      draftId,
      submissionId: '11111111-1111-4111-8111-111111111111',
      status: 'started',
      channel: 'gmail',
      to: 'ada@example.com',
      mailAccount: 'personal',
      body: 'Edited',
    })

    await expect(drafts.reconcileStarted()).resolves.toBe(1)
    await expect(drafts.submit(chat.id, draftId, 'Retry')).resolves.toBe(false)
    expect(send.sent).toEqual([])
    expect((await store.loadEvents(chat.id)).at(-1)).toMatchObject({
      type: 'outbound_draft_submission',
      status: 'uncertain',
      message: expect.stringContaining('server restarted'),
      body: 'Edited',
    })
    await expect(store.listUnresolvedOutboundSubmissions()).resolves.toEqual([])
  })

  it('records a safe send failure on the draft and allows a corrected retry', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const send = {
      send: async () => ({ ok: false, certainty: 'safe', message: 'Slack session expired.' } as const),
    }
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined })
    const { draftId } = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'slack',
      to: '#general',
      slackChannelId: 'C044BJUQ60T',
      body: 'Original',
    })

    expect(await drafts.submit(chat.id, draftId, 'Edited')).toBe(false)
    expect((await store.loadEvents(chat.id)).at(-1)).toMatchObject({
      type: 'outbound_draft_submission',
      status: 'failed',
      message: 'Slack session expired.',
    })
    expect(await drafts.discard(chat.id, draftId)).toBe(true)
    expect((await store.loadEvents(chat.id)).some((event) => event.type === 'system_note')).toBe(false)
  })

  it('locks an uncertain delivery instead of risking a duplicate retry', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    let sends = 0
    const drafts = new OutboundDrafts({
      store,
      send: {
        async send() {
          sends += 1
          return { ok: false, certainty: 'uncertain', message: 'SMTP timed out after upload.' }
        },
      },
      emit: () => undefined,
    })
    const { draftId } = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail',
      to: 'ada@example.com',
      body: 'Original',
    })

    expect(await drafts.submit(chat.id, draftId, 'Edited')).toBe(false)
    expect(await drafts.submit(chat.id, draftId, 'Retry')).toBe(false)
    expect(sends).toBe(1)
    expect((await store.loadEvents(chat.id)).at(-1)).toMatchObject({
      type: 'outbound_draft_submission',
      status: 'uncertain',
      message: 'SMTP timed out after upload.',
    })
  })

  it('rejects invalid content before writing an event', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const drafts = new OutboundDrafts({
      store,
      send: new RecordingOutboundSend(),
      emit: () => undefined,
    })

    await expect(drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail',
      to: ' ',
      body: 'Hello',
    })).rejects.toThrow('Invalid outbound draft.')
    await expect(drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'slack',
      to: '#general',
      body: 'Hello',
    } as never)).rejects.toThrow('Invalid outbound draft.')
    await expect(drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail',
      to: ['ada@example.com'],
      body: 'Hello',
      mailAccount: 'personal',
      thread,
    } as never)).rejects.toThrow('Invalid outbound draft.')
    await expect(drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail',
      to: 'ada@example.com',
      body: 'Hello',
      mailAccount: 'personal',
      threadId: thread.threadId,
      previous: thread.previous,
      earlierCount: thread.earlierCount,
    } as never)).rejects.toThrow('Invalid outbound draft.')
    await expect(drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail',
      to: 'ada@example.com',
      body: 'Hello',
      mailAccount: 'personal',
      thread: { ...thread, previous: 'Ada' },
    } as never)).rejects.toThrow('Invalid outbound draft.')
    expect(await store.loadEvents(chat.id)).toEqual([])
  })

  it.each(['gmail', 'slack'] as const)('prepares a fresh %s card in an empty chat after Ignore without restoring the old item', async (channel) => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const send = new RecordingOutboundSend()
    const drafts = new OutboundDrafts({ store, send, emit: () => undefined })
    const content = channel === 'gmail'
      ? { channel, to: 'ada@example.com', body: 'Reply', mailAccount: 'personal' as const, thread }
      : {
          channel, to: '#general', body: 'Reply', slackChannelId: 'C044BJUQ60T',
          slackThreadTs: '1725181200.000001',
          thread: { ...thread, threadId: '1725181200.000001', openUrl: 'https://slack.com/archives/C044BJUQ60T/p1725181200000001' },
        }
    const first = await drafts.record(chat.id, 'marlow', 'turn_1', content)
    if (!('draftId' in first)) throw new Error('expected a draft')

    expect(await drafts.ignore(chat.id, first.draftId)).toBe(true)
    const oldEvents = await store.loadEvents(chat.id)
    expect(oldEvents.at(-1)).toMatchObject({ type: 'outbound_draft_closed', draftId: first.draftId, outcome: 'ignored' })
    const decisionKey = { channel, route: channel === 'gmail' ? 'personal' : 'C044BJUQ60T', threadId: content.thread.threadId }
    const decision = await store.getOutboundThreadDecision(decisionKey)
    expect(decision).toMatchObject({ kind: 'ignored' })

    const nextChat = await store.createChat({ projectId: project!.id, title: 'New reply', memberIds: [] })
    expect(await store.loadEvents(nextChat.id)).toEqual([])
    const second = await drafts.record(nextChat.id, 'jeeves', 'turn_2', {
      ...content, body: 'New reply',
      thread: { ...content.thread, previous: { ...thread.previous, text: 'Following up' } },
    })
    if (!('draftId' in second)) throw new Error('expected a new draft on the ignored thread')
    expect(second.draftId).not.toBe(first.draftId)
    expect(await store.loadEvents(nextChat.id)).toEqual([expect.objectContaining({
      type: 'outbound_draft', draftId: second.draftId, channel, body: 'New reply',
      thread: expect.objectContaining({ threadId: content.thread.threadId, previous: expect.objectContaining({ text: 'Following up' }) }),
    })])
    expect(await store.loadEvents(chat.id)).toEqual(oldEvents)
    expect(await store.getOutboundThreadDecision(decisionKey)).toEqual(decision)
    expect(await drafts.submit(chat.id, first.draftId, 'Old reply')).toBe(false)
    expect(send.sent).toEqual([])
    expect(await drafts.submit(nextChat.id, second.draftId, 'New reply')).toBe(true)
    expect(send.sent).toHaveLength(1)
  })

  it('suppresses a snoozed thread only until its durable deadline', async () => {
    let now = 1_000
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const drafts = new OutboundDrafts({
      store,
      send: new RecordingOutboundSend(),
      emit: () => undefined,
      now: () => now,
    })
    const first = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail', to: 'ada@example.com', body: 'Reply', thread,
    })
    if (!('draftId' in first)) throw new Error('expected a draft')
    expect(await drafts.snooze(chat.id, first.draftId, 2_000)).toBe(true)
    await expect(drafts.record(chat.id, 'marlow', 'turn_2', {
      channel: 'gmail', to: 'ada@example.com', body: 'Too early', thread,
    })).resolves.toEqual({ suppressed: 'snoozed', until: 2_000 })

    now = 2_001
    await expect(drafts.record(chat.id, 'marlow', 'turn_3', {
      channel: 'gmail', to: 'ada@example.com', body: 'Now due', thread,
    })).resolves.toHaveProperty('draftId')
  })

  it('restores an ignored draft and removes the routine filter', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const drafts = new OutboundDrafts({ store, send: new RecordingOutboundSend(), emit: () => undefined })
    const first = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail', to: 'ada@example.com', body: 'Reply', thread,
    })
    if (!('draftId' in first)) throw new Error('expected a draft')
    expect(await drafts.ignore(chat.id, first.draftId)).toBe(true)
    expect(await drafts.restore(chat.id, first.draftId)).toBe(true)
    expect(await drafts.submit(chat.id, first.draftId, 'Restored reply')).toBe(true)
    await expect(drafts.record(chat.id, 'marlow', 'turn_2', {
      channel: 'gmail', to: 'ada@example.com', body: 'Fresh', thread,
    })).resolves.toHaveProperty('draftId')
  })

  it('loads a full thread only from the route stored on the draft', async () => {
    const store = createMemoryStore()
    const [project] = await store.listProjects()
    const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
    const read = async () => ({
      messages: [{ id: 'mail_1', from: 'Ada', at: '2026-09-01T08:00:00.000Z', text: 'Can you reply?' }],
      truncated: false,
    })
    const drafts = new OutboundDrafts({
      store,
      send: new RecordingOutboundSend(),
      emit: () => undefined,
      threadReader: { read },
    })
    const first = await drafts.record(chat.id, 'marlow', 'turn_1', {
      channel: 'gmail', to: 'ada@example.com', body: 'Reply', thread,
    })
    if (!('draftId' in first)) throw new Error('expected a draft')
    await expect(drafts.readThread(chat.id, first.draftId)).resolves.toEqual(await read())
    await expect(drafts.readThread(chat.id, 'missing')).resolves.toBeUndefined()
  })
})


it('preserves rich text through restore, edited submission, refusal and retry', async () => {
  const store = createMemoryStore()
  const [project] = await store.listProjects()
  const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
  const send = new RecordingOutboundSend()
  const drafts = new OutboundDrafts({ store, send, emit: () => undefined })
  const formatted = (text: string) => ({ type: 'rich_text' as const, elements: [
    { type: 'rich_text_section' as const, elements: [{ type: 'text' as const, text, style: { bold: true } }] },
  ] })
  const recorded = await drafts.record(chat.id, 'smith', 'turn', {
    channel: 'slack', to: 'Self', slackChannelId: 'D12345678', body: 'stale', slackRichText: formatted('Original'),
    thread: { threadId: '1234567890.123456', previous: { from: 'Self', at: '2026-09-11T00:00:00Z', text: 'Hi' }, earlierCount: 0 },
  })
  if (!('draftId' in recorded)) throw new Error('expected draft')
  const { draftId } = recorded
  expect((await store.loadEvents(chat.id))[0]).toMatchObject({ body: 'Original', slackRichText: formatted('Original') })
  expect(await drafts.ignore(chat.id, draftId)).toBe(true)
  expect(await drafts.restore(chat.id, draftId)).toBe(true)
  // Old clients cannot silently strip formatting, and malformed documents never claim a send.
  expect(await drafts.submit(chat.id, draftId, 'Plain')).toBe(false)
  expect(await drafts.submit(chat.id, draftId, 'Plain', undefined, { type: 'rich_text', elements: [] })).toBe(false)
  expect(send.sent).toEqual([])
  const refused = new OutboundDrafts({ store, send: { send: async () => ({ ok: false, certainty: 'safe', message: 'Refused' }) }, emit: () => undefined })
  expect(await refused.submit(chat.id, draftId, 'stale', undefined, formatted('Edited'))).toBe(false)
  const failed = (await store.loadEvents(chat.id)).filter((event) => event.type === 'outbound_draft_submission')
  expect(failed).toHaveLength(2)
  expect(failed.every((event) => event.body === 'Edited' && JSON.stringify(event.slackRichText) === JSON.stringify(formatted('Edited')))).toBe(true)
  expect(await drafts.submit(chat.id, draftId, 'stale', undefined, formatted('Retry'))).toBe(true)
  expect(send.sent[0]).toMatchObject({ body: 'Retry', slackRichText: formatted('Retry') })
  expect(await drafts.submit(chat.id, draftId, 'stale', undefined, formatted('Again'))).toBe(false)
})

it('keeps the rich document on an orphaned send claim after restart', async () => {
  const store = createMemoryStore()
  const [project] = await store.listProjects()
  const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
  const slackRichText = { type: 'rich_text' as const, elements: [{ type: 'rich_text_section' as const, elements: [{ type: 'text' as const, text: 'Keep', style: { italic: true } }] }] }
  await store.appendEvent(chat.id, { type: 'outbound_draft_submission', agentId: 'smith', turnId: 'turn', draftId: 'draft', submissionId: '11111111-1111-4111-8111-111111111111', status: 'started', channel: 'slack', to: 'Self', slackChannelId: 'D12345678', body: 'Keep', slackRichText })
  const drafts = new OutboundDrafts({ store, send: new RecordingOutboundSend(), emit: () => undefined })
  expect(await drafts.reconcileStarted()).toBe(1)
  expect((await store.loadEvents(chat.id)).at(-1)).toMatchObject({ status: 'uncertain', slackRichText })
})


it('protects formatting added to a plain draft when retrying a refused send', async () => {
  const store = createMemoryStore()
  const [project] = await store.listProjects()
  const chat = await store.createChat({ projectId: project!.id, title: 'Drafts', memberIds: [] })
  const drafts = new OutboundDrafts({ store, send: { send: async () => ({ ok: false, certainty: 'safe', message: 'Refused' }) }, emit: () => undefined })
  const { draftId } = await drafts.record(chat.id, 'smith', 'turn', { channel: 'slack', to: 'Self', slackChannelId: 'D12345678', body: 'Plain' })
  const rich = { type: 'rich_text' as const, elements: [{ type: 'rich_text_section' as const, elements: [{ type: 'text' as const, text: 'Edited', style: { bold: true } }] }] }
  expect(await drafts.submit(chat.id, draftId, 'Edited', undefined, rich)).toBe(false)
  const send = new RecordingOutboundSend()
  const retry = new OutboundDrafts({ store, send, emit: () => undefined })
  expect(await retry.submit(chat.id, draftId, 'Edited')).toBe(false)
  expect(send.sent).toEqual([])
  // Removing all styling is explicit and still uses the document.
  const unstyled = { type: 'rich_text' as const, elements: [{ type: 'rich_text_section' as const, elements: [{ type: 'text' as const, text: 'Edited' }] }] }
  expect(await retry.submit(chat.id, draftId, 'Edited', undefined, unstyled)).toBe(true)
  expect(send.sent[0]).toMatchObject({ slackRichText: unstyled })
})
