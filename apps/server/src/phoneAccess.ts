import type { ClientMessage, PhoneAccess, ServerMessage, TailscaleStatus } from '@manor/contracts'
import { pairingLink } from '@manor/contracts'
import type { IncomingHttpHeaders } from 'node:http'
import { isLoopbackHost } from './config.js'
import { MYMIND_THUMBNAIL_PREFIX } from './mymind.js'
import type { PairedDevices } from './pairedDevices.js'
import type { TailscaleServe } from './tailscale.js'

/**
 * Tailscale Serve hands tailnet requests over from loopback with `X-Forwarded-For` set.
 * Routes that trust a loopback caller (internal and MCP) must not take one that came
 * through it, and a server with its door off takes none at all. The thumbnail route
 * checks its own signed capability, so it stays reachable.
 */
export function refusesForwarded(
  request: { url?: string; headers: IncomingHttpHeaders },
  options: { authOff: boolean; isMcp: (url: string | undefined) => boolean },
): boolean {
  if (request.headers['x-forwarded-for'] === undefined) return false
  if (options.authOff) return true
  const url = request.url ?? ''
  const internal = url.startsWith('/internal/') && !url.startsWith(MYMIND_THUMBNAIL_PREFIX)
  return internal || options.isMcp(request.url)
}

type PhoneMessage = Extract<ClientMessage, { type: 'get_phone_access' | 'create_pairing_link' | 'revoke_device' | 'set_tailscale_serve' }>

const PHONE_MESSAGES = new Set<string>(['get_phone_access', 'create_pairing_link', 'revoke_device', 'set_tailscale_serve'])

/** The part of a socket this module touches; narrow so tests can fake it. */
export interface PhoneSocket {
  terminate(): void
}

interface Connection {
  deviceId: string | undefined
  /** The Host header the socket came in on, for a link when Tailscale serves nothing. */
  host: string | undefined
}

/**
 * Settings → Phone on the server: Tailscale HTTPS, pairing links and the paired
 * devices, plus which open socket belongs to which device, so a revoke closes that
 * device's connection at once instead of when it next reconnects.
 */
export function createPhoneAccess(options: {
  devices: PairedDevices
  tailscale: TailscaleServe
  broadcast: (message: ServerMessage) => void
  /** Removes a push address from the house's list, so a revoked phone gets no more notices. */
  dropPushToken: (token: string) => void
}) {
  const sockets = new Map<PhoneSocket, Connection>()
  let tailscale: TailscaleStatus | undefined

  const access = (): PhoneAccess => {
    const connected = new Set([...sockets.values()].flatMap((entry) => entry.deviceId === undefined ? [] : [entry.deviceId]))
    return {
      tailscale: tailscale ?? { state: 'checking' },
      devices: options.devices.list().map((device) => ({ ...device, connected: connected.has(device.id) })),
    }
  }
  const announce = () => options.broadcast({ type: 'phone_access', access: access() })

  const closeDevice = (deviceId: string) => {
    for (const [socket, entry] of sockets) {
      if (entry.deviceId !== deviceId) continue
      sockets.delete(socket)
      socket.terminate()
    }
  }

  /** Revoke from Settings or from the device itself: token, push address and open sockets all go. */
  const forget = (deviceId: string) => {
    const pushToken = options.devices.pushToken(deviceId)
    options.devices.revoke(deviceId)
    if (pushToken !== null) options.dropPushToken(pushToken)
    closeDevice(deviceId)
    announce()
  }

  return {
    handles: (message: ClientMessage): message is PhoneMessage => PHONE_MESSAGES.has(message.type),

    /** A socket that passed the handshake. `token` is the one it showed there. */
    attach(socket: PhoneSocket, token: string | null, host: string | undefined) {
      const deviceId = token === null ? undefined : options.devices.verify(token)
      sockets.set(socket, { deviceId, host })
      if (deviceId === undefined) return
      options.devices.touch(deviceId)
      announce()
    },

    detach(socket: PhoneSocket) {
      const entry = sockets.get(socket)
      if (entry === undefined) return
      sockets.delete(socket)
      if (entry.deviceId === undefined) return
      options.devices.touch(entry.deviceId)
      announce()
    },

    /** Remembers which device registered a push address, when the socket belongs to one. */
    notePushToken(socket: PhoneSocket, token: string) {
      const deviceId = sockets.get(socket)?.deviceId
      if (deviceId === undefined) return
      // A rotated address replaces the old one, which would otherwise outlive a revoke.
      const previous = options.devices.pushToken(deviceId)
      if (previous !== null && previous !== token) options.dropPushToken(previous)
      options.devices.notePushToken(deviceId, token)
    },

    forget,
    announce,

    async handle(socket: PhoneSocket, message: PhoneMessage, reply: (message: ServerMessage) => void): Promise<void> {
      const requestId = message.requestId === undefined ? {} : { requestId: message.requestId }
      const ack = () => { if (message.requestId !== undefined) reply({ type: 'ack', requestId: message.requestId }) }
      switch (message.type) {
        case 'get_phone_access':
          tailscale = await options.tailscale.status()
          reply({ type: 'phone_access', access: access(), ...requestId })
          return
        case 'set_tailscale_serve':
          tailscale = await options.tailscale.setServing(message.on)
          announce()
          ack()
          return
        case 'revoke_device':
          forget(message.deviceId)
          ack()
          return
        case 'create_pairing_link': {
          tailscale = await options.tailscale.status()
          const host = sockets.get(socket)?.host
          const origin = tailscale.state === 'ready' && tailscale.serving
            ? tailscale.address
            : host === undefined ? undefined : `http://${host}`
          if (origin === undefined) {
            reply({ type: 'notice', kind: 'error', text: 'Turn on Tailscale HTTPS first, so your phone can reach this Mac.', ...requestId })
            return
          }
          const { code, expiresAt } = options.devices.createCode()
          const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '')
          reply({ type: 'pairing_link', link: pairingLink(origin, code), expiresAt, loopback: isLoopbackHost(hostname), ...requestId })
          ack()
          return
        }
      }
    },
  }
}

export type PhoneAccessModule = ReturnType<typeof createPhoneAccess>
