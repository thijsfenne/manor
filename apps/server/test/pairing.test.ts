import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePairingLink, type ServerMessage } from '@manor/contracts'
import { createGate, createUpgradeGuard } from '../src/auth.js'
import { PAIRING_CODE_TTL_MS, PairedDevices, handlePairingRequest, handlesPairingRequest } from '../src/pairedDevices.js'
import { createPhoneAccess, refusesForwarded } from '../src/phoneAccess.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import type { TailscaleServe } from '../src/tailscale.js'

function devicesAt(start = 1_000_000) {
  let now = start
  const store = createMemoryStore() as ReturnType<typeof createMemoryStore> & { db: import('node:sqlite').DatabaseSync }
  return { devices: new PairedDevices(store.db, () => now), advance: (ms: number) => { now += ms }, db: store.db }
}

describe('pairing codes', () => {
  it('pair a device once, and never a second time', () => {
    const { devices } = devicesAt()
    const { code } = devices.createCode()

    const paired = devices.redeem(code, 'iPhone')
    expect(paired).not.toBeNull()
    expect(devices.redeem(code, 'Second phone')).toBeNull()
    expect(devices.list().map((device) => device.name)).toEqual(['iPhone'])
  })

  it('stop working after ten minutes', () => {
    const { devices, advance } = devicesAt()
    const { code, expiresAt } = devices.createCode()

    expect(expiresAt).toBe(1_000_000 + PAIRING_CODE_TTL_MS)
    advance(PAIRING_CODE_TTL_MS)
    expect(devices.redeem(code, 'iPhone')).toBeNull()
  })

  it('refuses a code that was never issued', () => {
    const { devices } = devicesAt()
    devices.createCode()
    expect(devices.redeem('A'.repeat(43), 'iPhone')).toBeNull()
  })
})

describe('device tokens', () => {
  it('are stored as a hash only, and stop working on revoke', () => {
    const { devices, db } = devicesAt()
    const paired = devices.redeem(devices.createCode().code, 'iPhone')!
    const [, secret] = paired.token.split('.')

    const stored = JSON.stringify(db.prepare('SELECT * FROM paired_devices').all())
    expect(stored).not.toContain(secret)
    expect(devices.verify(paired.token)).toBe(paired.deviceId)
    expect(devices.verify(`${paired.deviceId}.${'B'.repeat(43)}`)).toBeUndefined()
    expect(devices.verify('not-a-token')).toBeUndefined()

    expect(devices.revoke(paired.deviceId)).toBe(true)
    expect(devices.verify(paired.token)).toBeUndefined()
  })

  it('open the WebSocket handshake, and a revoked one does not', async () => {
    const { devices } = devicesAt()
    const paired = devices.redeem(devices.createCode().code, 'iPhone')!
    const gate = createGate({ mode: 'on', filename: '/private/manor.db' }, { verify: (token) => Promise.resolve(devices.verify(token) !== undefined) })
    const guard = createUpgradeGuard({ path: '/ws', gate, allowedOrigins: [] })
    const upgrade = (token: string) => guard({ url: `/ws?token=${encodeURIComponent(token)}`, headers: {} })

    expect(await upgrade(paired.token)).toEqual({ ok: true })
    devices.revoke(paired.deviceId)
    expect(await upgrade(paired.token)).toMatchObject({ ok: false, status: 401 })
  })
})

describe('the pairing routes', () => {
  let server: Server | undefined
  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined))
    server = undefined
  })

  async function serve(devices: PairedDevices, onForget = (deviceId: string) => { devices.revoke(deviceId) }) {
    server = createServer((request, response) => {
      if (handlesPairingRequest(request)) void handlePairingRequest(request, response, devices, { allowedOrigins: [], onChange: () => undefined, onForget })
      else { response.writeHead(200); response.end('page') }
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }

  it('redeem a code over HTTP and accept the token as a bearer', async () => {
    const { devices } = devicesAt()
    const origin = await serve(devices)
    const { code } = devices.createCode()
    const redeem = () => fetch(`${origin}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'iPhone' }) })

    const first = await redeem()
    expect(first.status).toBe(200)
    const { token } = await first.json() as { token: string }
    expect((await redeem()).status).toBe(410)

    const me = await fetch(`${origin}/pair/device`, { headers: { Authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ name: 'iPhone' })
    expect((await fetch(`${origin}/pair/device`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await fetch(`${origin}/pair/device`)).status).toBe(401)
  })

  it('leave GET /pair to the web app, which reads the code from the fragment', async () => {
    const { devices } = devicesAt()
    const origin = await serve(devices)
    expect(await (await fetch(`${origin}/pair`)).text()).toBe('page')
  })

  it('refuse a browser from another origin', async () => {
    const { devices } = devicesAt()
    const origin = await serve(devices)
    const response = await fetch(`${origin}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.example' },
      body: JSON.stringify({ code: devices.createCode().code, name: 'Browser' }),
    })
    expect(response.status).toBe(403)
    expect(devices.list()).toEqual([])
  })

  it('let a device forget itself', async () => {
    const { devices } = devicesAt()
    const onForget = vi.fn((deviceId: string) => { devices.revoke(deviceId) })
    const origin = await serve(devices, onForget)
    const paired = devices.redeem(devices.createCode().code, 'iPhone')!

    const response = await fetch(`${origin}/pair/device`, { method: 'DELETE', headers: { Authorization: `Bearer ${paired.token}` } })
    expect(response.status).toBe(200)
    expect(onForget).toHaveBeenCalledWith(paired.deviceId)
    expect(devices.verify(paired.token)).toBeUndefined()
  })
})

describe('Settings → Phone', () => {
  const tailscale = (address?: string): TailscaleServe => ({
    status: () => Promise.resolve(address === undefined ? { state: 'missing' } : { state: 'ready', address, serving: true }),
    setServing: () => Promise.resolve({ state: 'missing' }),
  })
  const socket = () => ({ terminate: vi.fn() })

  it('closes a revoked device\'s open connection at once, drops its push address and leaves the others', async () => {
    const { devices } = devicesAt()
    const broadcast = vi.fn<(message: ServerMessage) => void>()
    const dropPushToken = vi.fn()
    const phone = createPhoneAccess({ devices, tailscale: tailscale(), broadcast, dropPushToken })
    const kept = devices.redeem(devices.createCode().code, 'iPad')!
    const revoked = devices.redeem(devices.createCode().code, 'iPhone')!
    const iphone = socket()
    const ipad = socket()
    const desk = socket()
    phone.attach(iphone, revoked.token, 'mac.example.ts.net')
    phone.attach(ipad, kept.token, 'mac.example.ts.net')
    phone.attach(desk, null, '127.0.0.1:43179')
    phone.notePushToken(iphone, 'ExpoPushToken[old]')
    phone.notePushToken(iphone, 'ExpoPushToken[iphone]')
    phone.notePushToken(desk, 'ExpoPushToken[desk]')

    await phone.handle(desk, { type: 'revoke_device', deviceId: revoked.deviceId, requestId: 'r1' }, () => undefined)

    expect(iphone.terminate).toHaveBeenCalledOnce()
    expect(ipad.terminate).not.toHaveBeenCalled()
    expect(desk.terminate).not.toHaveBeenCalled()
    expect(dropPushToken.mock.calls).toEqual([['ExpoPushToken[old]'], ['ExpoPushToken[iphone]']])
    const last = broadcast.mock.calls.at(-1)?.[0]
    expect(last?.type === 'phone_access' && last.access.devices.map((device) => [device.name, device.connected])).toEqual([['iPad', true]])
  })

  it('makes the link on the Tailscale address while it serves, else on the address the asking client used, never on loopback', async () => {
    const { devices } = devicesAt()
    const replies: ServerMessage[] = []
    const desk = socket()

    const served = createPhoneAccess({ devices, tailscale: tailscale('https://mac.example.ts.net'), broadcast: () => undefined, dropPushToken: () => undefined })
    served.attach(desk, null, '127.0.0.1:43179')
    await served.handle(desk, { type: 'create_pairing_link' }, (message) => replies.push(message))

    const local = createPhoneAccess({ devices, tailscale: tailscale(), broadcast: () => undefined, dropPushToken: () => undefined })
    const lan = socket()
    local.attach(lan, null, '192.168.1.20:43179')
    await local.handle(lan, { type: 'create_pairing_link' }, (message) => replies.push(message))
    for (const host of ['127.0.0.1:43179', '127.0.0.2:43179', 'localhost:43179', 'localhost.:43179', '[::1]:43179']) {
      local.attach(desk, null, host)
      await local.handle(desk, { type: 'create_pairing_link', requestId: host }, (message) => replies.push(message))
    }

    const links = replies.flatMap((message) => message.type === 'pairing_link' ? [message] : [])
    expect(links.map((link) => parsePairingLink(link.link)?.origin)).toEqual(['https://mac.example.ts.net', 'http://192.168.1.20:43179'])
    const refused = replies.flatMap((message) => message.type === 'notice' ? [message.requestId] : [])
    expect(refused).toEqual(['127.0.0.1:43179', '127.0.0.2:43179', 'localhost:43179', 'localhost.:43179', '[::1]:43179'])
    expect(devices.redeem(parsePairingLink(links[0]!.link)!.code, 'iPhone')).not.toBeNull()
  })
})

describe('requests from the tailnet', () => {
  const tailnet = (url: string) => ({ url, headers: { 'x-forwarded-for': '100.64.0.2' } })
  const isMcp = (url: string | undefined) => url?.startsWith('/mcp/') === true

  it('refuses loopback-only routes when Tailscale Serve forwarded the request', () => {
    expect(refusesForwarded(tailnet('/internal/anything'), { authOff: false, isMcp })).toBe(true)
    expect(refusesForwarded(tailnet('/mcp/manor'), { authOff: false, isMcp })).toBe(true)
    expect(refusesForwarded(tailnet('/internal/mymind-thumbnail/abc'), { authOff: false, isMcp })).toBe(false)
    expect(refusesForwarded(tailnet('/pair'), { authOff: false, isMcp })).toBe(false)
  })

  it('refuses everything forwarded while the door is off, and nothing from this Mac', () => {
    expect(refusesForwarded(tailnet('/pair'), { authOff: true, isMcp })).toBe(true)
    expect(refusesForwarded({ url: '/internal/anything', headers: {} }, { authOff: true, isMcp })).toBe(false)
  })
})
