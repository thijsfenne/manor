import { describe, expect, it, vi } from 'vitest'
import { PRESENCE_FRESH_MS, createDesktopPresence } from '../src/desktopPresence.js'
import { PUSH_NOTICE_FLOOR_MS, createPushNotifier } from '../src/pushNotifications.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, seededChat } from './helpers.js'

const TOKEN = 'ExpoPushToken[manor-device-1]'
const ok = () => new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket_1' }] }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

async function rig() {
  const store = createMemoryStore({ agents: roster })
  const { chatId } = await seededChat(store)
  await store.savePushToken(TOKEN)
  let clock = 1_000_000
  const presence = createDesktopPresence({ now: () => clock })
  const request = vi.fn(async () => ok())
  const lines: string[] = []
  const notifier = createPushNotifier({
    store,
    agents: () => roster,
    fetch: request as unknown as typeof fetch,
    now: () => clock,
    schedule: () => undefined,
    presence,
    log: (line) => void lines.push(line),
  })
  const mac = {}
  const finish = () => notifier.notifyChatFinished(chatId, clock - PUSH_NOTICE_FLOOR_MS - 1)
  return { store, chatId, clock: (ms: number) => { clock += ms }, presence, request, lines, notifier, mac, finish }
}

describe('phone pushes while the Mac is in use', () => {
  it('sends when the Mac never reported', async () => {
    const { finish, request, lines } = await rig()
    await finish()
    expect(request).toHaveBeenCalledOnce()
    expect(lines).toEqual([expect.stringContaining('sending: mac never reported')])
  })

  it('holds back every kind of push while a fresh beat says active, and logs each', async () => {
    const { chatId, presence, mac, clock, notifier, finish, request, lines } = await rig()
    presence.report(mac, true)
    clock(20_000)

    await finish()
    await notifier.notifyAwaitingInput(chatId, 'sage', [{ id: 'q', question: 'Doorgaan?', options: [{ label: 'Ja' }] }])
    await notifier.notifyHost('Manor', 'Something broke')

    expect(request).not.toHaveBeenCalled()
    expect(lines).toEqual([
      `[manor] push kind=chat-finished chat=${chatId} devices=1 skipped: mac active, last beat 20s ago`,
      `[manor] push kind=awaiting-input chat=${chatId} devices=1 skipped: mac active, last beat 20s ago`,
      '[manor] push kind=host-notice chat=- devices=1 skipped: mac active, last beat 20s ago',
    ])
  })

  it('sends again once the beats stop', async () => {
    const { presence, mac, clock, finish, request, lines } = await rig()
    presence.report(mac, true)
    clock(PRESENCE_FRESH_MS + 1)
    await finish()
    expect(request).toHaveBeenCalledOnce()
    expect(lines.at(-1)).toContain('sending: mac stale')
  })

  it('sends again after the host says the Mac is locked or idle', async () => {
    const { presence, mac, clock, finish, request, lines } = await rig()
    presence.report(mac, true)
    clock(5_000)
    await finish()
    expect(request).not.toHaveBeenCalled()

    presence.report(mac, false)
    await finish()
    expect(request).toHaveBeenCalledOnce()
    expect(lines.at(-1)).toContain('sending: mac away')
  })

  it('sends again when the reporting socket closes', async () => {
    const { presence, mac, finish, request } = await rig()
    presence.report(mac, true)
    presence.drop(mac)
    await finish()
    expect(request).toHaveBeenCalledOnce()
  })

  it('holds the push back when the Mac turns active while the notice is still loading', async () => {
    const { presence, mac, finish, request, store, lines } = await rig()
    const getChat = store.getChat.bind(store)
    store.getChat = async (id) => {
      presence.report(mac, true)
      return getChat(id)
    }
    await finish()
    expect(request).not.toHaveBeenCalled()
    expect(lines).toEqual([expect.stringContaining('skipped: mac active')])
  })

  it('logs the decision even when Expo then refuses the request', async () => {
    const { finish, request, lines } = await rig()
    request.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(finish()).rejects.toThrow('Expo push answered 500')
    expect(lines).toEqual([expect.stringContaining('sending: mac never reported')])
  })

  it('stays quiet while any one desktop socket is fresh', async () => {
    const { presence, mac, finish, request } = await rig()
    const other = {}
    presence.report(mac, true)
    presence.report(other, false)
    await finish()
    expect(request).not.toHaveBeenCalled()
  })
})
