import { describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '@manor/contracts'
import {
  PUSH_NOTICE_FLOOR_MS,
  completionNotice,
  createPushNotifier,
  pushPreview,
} from '../src/pushNotifications.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { ManorService } from '../src/service.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, scratchFor, seededChat } from './helpers.js'

const TOKEN = 'ExpoPushToken[manor-device-1]'
const ok = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

describe('mobile completion pushes', () => {
  it('registers a device and announces one whole service exchange', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const finished: { chatId: string; startedAt: number }[] = []
    const replies: ServerMessage[] = []
    const manor = new ManorService({
      store,
      agents: () => roster,
      setAgents: () => undefined,
      mcpServers: () => [],
      setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor,
      broadcast: () => undefined,
      onChatFinished: (finishedChatId, startedAt) => void finished.push({ chatId: finishedChatId, startedAt }),
    })

    await manor.handle(
      { type: 'register_push_token', token: TOKEN, requestId: 'register-device' },
      (message) => void replies.push(message),
    )
    await manor.handle({ type: 'send_message', chatId, text: '@Smith ship it' }, () => undefined)

    expect(await store.listPushTokens()).toEqual([TOKEN])
    expect(replies).toContainEqual({ type: 'ack', requestId: 'register-device' })
    expect(finished).toHaveLength(1)
    expect(finished[0]?.chatId).toBe(chatId)

    await manor.handle(
      { type: 'unregister_push_token', token: TOKEN, requestId: 'unregister-device' },
      (message) => void replies.push(message),
    )
    expect(await store.listPushTokens()).toEqual([])
    expect(replies).toContainEqual({ type: 'ack', requestId: 'unregister-device' })
  })

  it('names who finished and previews the answer through the push provider', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const chat = await store.getChat(chatId)
    if (chat === undefined) throw new Error('the seeded chat should exist')
    await store.setChatTitle(chat.id, 'Shipping notifications')
    await store.savePushToken(TOKEN)
    await store.appendEvent(chat.id, {
      type: 'agent_message',
      agentId: 'smith',
      turnId: 'turn_1',
      text: 'Klaar, alles groen.',
    })
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      ok({ data: [{ status: 'ok', id: 'ticket_1' }] }),
    )
    const notifier = createPushNotifier({
      store,
      agents: () => roster,
      fetch: request as unknown as typeof fetch,
      now: () => PUSH_NOTICE_FLOOR_MS + 1,
      schedule: () => undefined,
    })

    await notifier.notifyChatFinished(chat.id, 0)

    expect(request).toHaveBeenCalledOnce()
    const [, init] = request.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toEqual([{
      to: TOKEN,
      sound: 'default',
      title: 'Shipping notifications',
      body: 'Smith: Klaar, alles groen.',
      data: { chatId: chat.id },
      threadId: chat.id,
    }])
  })

  it('keeps fast answers and settled work quiet', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.savePushToken(TOKEN)
    const request = vi.fn()
    const short = createPushNotifier({
      store,
      agents: () => roster,
      fetch: request as unknown as typeof fetch,
      now: () => PUSH_NOTICE_FLOOR_MS - 1,
    })
    await short.notifyChatFinished(chatId, 0)

    await store.setChatSettled(chatId, true)
    const settled = createPushNotifier({
      store,
      agents: () => roster,
      fetch: request as unknown as typeof fetch,
      now: () => PUSH_NOTICE_FLOOR_MS + 1,
    })
    await settled.notifyChatFinished(chatId, 0)

    expect(request).not.toHaveBeenCalled()
  })

  it('announces a persona waiting on a question or an approval at once, but not in a settled chat', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.setChatTitle(chatId, 'Belasting 2026')
    await store.savePushToken(TOKEN)
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      ok({ data: [{ status: 'ok', id: 'ticket_1' }] }),
    )
    // `now` sits inside the completion floor: a blocked turn is news however quick.
    const notifier = createPushNotifier({ store, agents: () => roster, fetch: request as unknown as typeof fetch, now: () => 1, schedule: () => undefined })
    const options = [{ label: 'Ja' }, { label: 'Nee' }]

    await notifier.notifyAwaitingInput(chatId, 'sage', [{ id: 'aftrek', question: 'Neem ik de werkkamer mee?', options }])
    await notifier.notifyAwaitingInput(chatId, 'smith', [{ id: 'allow', question: 'Mag Smith Safari bedienen?', options, optionsOnly: true }])
    const dm = await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Smith' })
    await notifier.notifyAwaitingInput(dm.id, 'smith', [{ id: 'other-chat', question: 'Nog een vraag?', options }])
    await store.setChatSettled(chatId, true)
    await notifier.notifyAwaitingInput(chatId, 'sage', [{ id: 'later', question: 'Nog iets?', options }])

    expect(request.mock.calls.map(([, init]) => JSON.parse(String(init?.body))[0])).toEqual([
      { to: TOKEN, sound: 'default', title: 'Belasting 2026', body: 'Sage asks: Neem ik de werkkamer mee?', data: { chatId }, threadId: chatId },
      { to: TOKEN, sound: 'default', title: 'Belasting 2026', body: 'Smith is waiting for your approval: Mag Smith Safari bedienen?', data: { chatId }, threadId: chatId },
      { to: TOKEN, sound: 'default', title: 'Smith', body: 'Asks: Nog een vraag?', data: { chatId: dm.id }, threadId: dm.id },
    ])
  })

  it('announces a one-time routine result however fast it came', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.savePushToken(TOKEN)
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket' }] })))
    const notifier = createPushNotifier({
      store,
      agents: () => roster,
      fetch: request as unknown as typeof fetch,
      now: () => 1,
      schedule: () => undefined,
    })

    await notifier.notifyChatFinished(chatId, 0, { alert: true })

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses the current persona name for a dm', async () => {
    const store = createMemoryStore({ agents: roster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Old Smith' })
    await store.appendEvent(dm.id, {
      type: 'agent_message',
      agentId: 'smith',
      turnId: 'turn_1',
      text: 'Gebouwd.',
    })

    expect(await completionNotice(store, roster, dm.id, 0)).toEqual({
      chatId: dm.id,
      title: 'Smith',
      body: 'Gebouwd.',
    })
  })

  it('does not push for an explicitly quiet DM routine', async () => {
    const store = createMemoryStore({ agents: roster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Smith' })
    await store.appendEvent(dm.id, {
      type: 'turn_result', agentId: 'smith', turnId: 'routine_1', routineOutcome: 'quiet',
    })

    expect(await completionNotice(store, roster, dm.id, 0)).toBeNull()
  })

  it('falls back to the persona when a project chat still has its generic title', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'smith',
      turnId: 'turn_1',
      text: 'No useful title yet.',
    })

    expect(await completionNotice(store, roster, chatId, 0)).toEqual({
      chatId,
      title: 'Smith',
      body: 'No useful title yet.',
    })
  })

  it('announces a notifying routine without exposing its name', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const routine = await store.saveRoutine({
      projectId,
      chatId: null,
      agentId: 'smith',
      name: 'Private client scan',
      prompt: 'Inspect private client material.',
      cron: '0 7 * * *',
      timezone: 'Europe/Amsterdam',
      enabled: true,
      notify: true,
      model: null,
      effort: null,
    })
    const run = await store.createChat({
      projectId,
      kind: 'run',
      routineId: routine.id,
      title: routine.name,
    })
    await store.appendEvent(run.id, {
      type: 'agent_message',
      agentId: 'smith',
      turnId: 'turn_1',
      text: 'Sensitive result.',
    })

    expect(await completionNotice(store, roster, run.id, 0)).toEqual({
      chatId: run.id,
      title: 'Private client scan',
      body: 'Smith: Sensitive result.',
    })

    await store.setChatSettled(run.id, true)
    expect(await completionNotice(store, roster, run.id, 0)).toBeNull()
  })

  it('trims an answer preview to three non-empty lines and a safe payload length', () => {
    expect(pushPreview('  One  \n\n Two \r\nThree\nFour')).toBe('One\nTwo\nThree…')
    expect(pushPreview('x'.repeat(300))).toBe(`${'x'.repeat(239)}…`)
    expect(pushPreview(' \n ')).toBe('Replied.')
  })

  it('sends a host notice without a chat to open', async () => {
    const store = createMemoryStore({ agents: roster })
    await store.savePushToken(TOKEN)
    const request = vi.fn(async () => ok({ data: [{ status: 'ok', id: 'ticket_1' }] }))
    const notifier = createPushNotifier({
      store,
      agents: () => roster,
      fetch: request as unknown as typeof fetch,
      schedule: () => undefined,
    })

    await notifier.notifyHost('Composio is offline', 'Press Test.')

    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    const [message] = JSON.parse(String(init.body))
    expect(message).toEqual({ to: TOKEN, sound: 'default', title: 'Composio is offline', body: 'Press Test.', data: {} })
  })

  it('removes an address Expo reports as unregistered', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.savePushToken(TOKEN)
    const notifier = createPushNotifier({
      store,
      agents: () => roster,
      fetch: (async () => ok({
        data: [{
          status: 'error',
          message: 'not registered',
          details: { error: 'DeviceNotRegistered' },
        }],
      })) as typeof fetch,
      now: () => PUSH_NOTICE_FLOOR_MS + 1,
    })

    await notifier.notifyChatFinished(chatId, 0)

    expect(await store.listPushTokens()).toEqual([])
  })

  it('checks a successful ticket later and removes a device rejected by APNs', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.savePushToken(TOKEN)
    let scheduled: (() => void) | undefined
    const request = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('getReceipts')
        ? ok({ data: { ticket_1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } })
        : ok({ data: [{ status: 'ok', id: 'ticket_1' }] }),
    )
    const notifier = createPushNotifier({
      store,
      agents: () => roster,
      fetch: request as unknown as typeof fetch,
      now: () => PUSH_NOTICE_FLOOR_MS + 1,
      schedule: (run) => {
        scheduled = run
      },
    })

    await notifier.notifyChatFinished(chatId, 0)
    scheduled?.()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(await store.listPushTokens()).toEqual([])
  })
})
