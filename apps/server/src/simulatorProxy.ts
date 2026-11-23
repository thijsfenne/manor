import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** Every simulator request starts here; the signed segment and the helper path follow. */
export const SIMULATOR_PROXY_PREFIX = '/simulator/'

/** How long a handed-out stream path opens new connections. A stream already open runs on. */
export const SIMULATOR_TICKET_TTL_MS = 30 * 60_000

/** How long the helper may take to accept the input socket. */
const UPGRADE_TIMEOUT_MS = 10_000

const UDID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}'

/**
 * The only helper routes a client may reach: the screen as JPEG frames, its size, and
 * the input socket. The helper also serves a host shell, device boots and
 * diagnostics on its own port; none of that is ever proxied, whatever the caller holds.
 */
const HTTP_ROUTES = new RegExp(`^/helper/${UDID}/(stream\\.mjpeg|config)$`, 'i')
const SOCKET_ROUTES = new RegExp(`^/helper/${UDID}/ws$`, 'i')

export interface SimulatorProxy {
  /** A fresh signed base path for stream URLs, such as `/simulator/<ticket>`. */
  streamBase(): string
  /** True when the request is the proxy's to answer (and then it always answers). */
  handles(url: string | undefined): boolean
  handle(request: IncomingMessage, response: ServerResponse): void
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void
  /** Voids every handed-out path and ends every open stream and input socket. */
  revokeAll(): void
}

/**
 * The one way into the screen helper, which binds loopback and is never reachable on
 * its own. Every request must carry a ticket this server signed and handed out over
 * an authenticated socket (an image or a WebSocket cannot carry a header), must name
 * an allowlisted route, and only reads: nothing but the input socket changes the device.
 */
export function createSimulatorProxy(options: {
  /** The helper's loopback port, or undefined while it is not running. */
  hubPort: () => number | undefined
  /** The origins the main socket accepts besides its own, for the input socket's Origin check. */
  allowedOrigins: readonly string[]
  key?: Buffer
  now?: () => number
}): SimulatorProxy {
  let key = options.key ?? randomBytes(32)
  const now = options.now ?? Date.now
  // Every open connection, so a revoke can end what a void ticket already opened.
  const live = new Set<{ destroy(): void }>()
  const own = (connection: { destroy(): void; once(event: 'close', listener: () => void): unknown }) => {
    live.add(connection)
    connection.once('close', () => live.delete(connection))
  }
  const allowedOrigins = new Set(options.allowedOrigins)
  const sign = (expires: string) => createHmac('sha256', key).update(`simulator:${expires}`).digest('base64url').slice(0, 32)

  const validTicket = (ticket: string) => {
    const [expires, signature, extra] = ticket.split('.')
    if (expires === undefined || signature === undefined || extra !== undefined || !/^[0-9a-z]{1,12}$/.test(expires)) return false
    const expected = Buffer.from(sign(expires))
    const provided = Buffer.from(signature)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false
    return parseInt(expires, 36) > now()
  }

  /** The helper path of an authorised request, or the status to refuse it with. */
  const route = (url: string | undefined, routes: RegExp): { path: string } | { status: 401 | 404 } => {
    let parsed: URL
    try {
      parsed = new URL(url ?? '/', 'http://manor.invalid')
    } catch {
      return { status: 404 }
    }
    const rest = parsed.pathname.slice(SIMULATOR_PROXY_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) return { status: 404 }
    if (!validTicket(rest.slice(0, slash))) return { status: 401 }
    const path = rest.slice(slash)
    return routes.test(path) ? { path } : { status: 404 }
  }

  const sameOrAllowedOrigin = (request: IncomingMessage) => {
    const origin = request.headers.origin
    if (origin === undefined) return true
    try {
      const parsed = new URL(origin)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && (parsed.host === request.headers.host || allowedOrigins.has(parsed.origin))
    } catch {
      return false
    }
  }

  return {
    streamBase() {
      const expires = (now() + SIMULATOR_TICKET_TTL_MS).toString(36)
      return `${SIMULATOR_PROXY_PREFIX}${expires}.${sign(expires)}`
    },
    handles: (url) => url?.startsWith(SIMULATOR_PROXY_PREFIX) === true,
    handle(request, response) {
      const refuse = (status: number) => {
        response.writeHead(status, { 'cache-control': 'no-store' })
        response.end()
      }
      const target = route(request.url, HTTP_ROUTES)
      if ('status' in target) return refuse(target.status)
      if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405)
      const port = options.hubPort()
      if (port === undefined) return refuse(503)
      // A fixed, minimal header set: no cookie, credential or forwarding header reaches
      // the helper, and its Host is its own loopback name, as it requires.
      own(response)
      const upstream = httpRequest({
        host: '127.0.0.1',
        port,
        method: request.method,
        path: target.path,
        headers: { host: `127.0.0.1:${port}`, accept: request.headers.accept ?? '*/*' },
      })
      upstream.on('response', (answer) => {
        response.writeHead(answer.statusCode ?? 502, {
          'content-type': answer.headers['content-type'] ?? 'application/octet-stream',
          // A stream never ends; a compressing or caching hop would hold it back.
          'cache-control': 'no-store, no-transform',
          'x-content-type-options': 'nosniff',
        })
        // A helper that drops the stream mid-way must end the browser's side too.
        answer.once('aborted', () => response.destroy())
        answer.once('error', () => response.destroy())
        answer.pipe(response)
      })
      upstream.on('error', () => {
        if (!response.headersSent) refuse(502)
        else response.destroy()
      })
      // Closing the panel ends the request, which must end the helper's subscription too.
      response.on('close', () => upstream.destroy())
      upstream.end()
    },
    upgrade(request, socket, head) {
      // Owned from the first byte: a browser that resets mid-handshake must not throw.
      socket.on('error', () => socket.destroy())
      const reject = (status: 401 | 403 | 404 | 502 | 503) => {
        if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
        socket.destroy()
      }
      const target = route(request.url, SOCKET_ROUTES)
      if ('status' in target) return reject(target.status)
      if (!sameOrAllowedOrigin(request)) return reject(403)
      const key = request.headers['sec-websocket-key']
      if (typeof key !== 'string') return reject(404)
      const port = options.hubPort()
      if (port === undefined) return reject(503)
      const helperOrigin = `127.0.0.1:${port}`
      const upstream = httpRequest({
        host: '127.0.0.1',
        port,
        path: target.path,
        headers: {
          host: helperOrigin,
          // The helper refuses a cross-origin socket; this one is its own.
          origin: `http://${helperOrigin}`,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': key,
          'sec-websocket-version': request.headers['sec-websocket-version'] ?? '13',
        },
        timeout: UPGRADE_TIMEOUT_MS,
      })
      own(socket)
      // The browser gave up before the helper answered: drop the half-open handshake.
      socket.once('close', () => upstream.destroy())
      upstream.once('timeout', () => upstream.destroy(new Error('timeout')))
      upstream.on('upgrade', (answer, helper, helperHead) => {
        const accept = answer.headers['sec-websocket-accept']
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${
            typeof accept === 'string' ? `Sec-WebSocket-Accept: ${accept}\r\n` : ''
          }\r\n`,
        )
        if (helperHead.length > 0) socket.write(helperHead)
        if (head.length > 0) helper.write(head)
        if (socket.destroyed) {
          helper.destroy()
          return
        }
        own(helper)
        // The handshake's time limit must not end an input socket that sits idle.
        helper.setTimeout(0)
        const close = () => {
          socket.destroy()
          helper.destroy()
        }
        helper.on('error', close)
        socket.on('error', close)
        helper.on('close', close)
        socket.on('close', close)
        helper.pipe(socket)
        socket.pipe(helper)
      })
      upstream.on('response', (answer) => {
        answer.resume()
        reject(answer.statusCode === 404 ? 404 : 502)
      })
      upstream.on('error', () => reject(502))
      upstream.end()
    },
    revokeAll() {
      key = randomBytes(32)
      for (const connection of [...live]) connection.destroy()
      live.clear()
    },
  }
}
