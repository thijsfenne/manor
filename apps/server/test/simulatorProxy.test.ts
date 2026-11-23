import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createSimulatorProxy, SIMULATOR_TICKET_TTL_MS } from '../src/simulatorProxy.js'

const UDID = '47EBE75E-A16D-4500-9F6E-D2DDB3213A09'

/**
 * A stand-in screen helper that answers every path, the shell route included, so
 * a refused request proves the proxy refused it rather than the helper.
 */
async function startHelper() {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} host=${req.headers.host} cookie=${req.headers.cookie ?? ''}`)
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(`helper:${req.url}`)
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket, req) => {
    seen.push(`WS ${req.url} origin=${req.headers.origin}`)
    socket.on('message', (data) => socket.send(`echo:${String(data)}`))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, port: (server.address() as AddressInfo).port }
}

async function startManor(hubPort: number | undefined, now = () => Date.now()) {
  const proxy = createSimulatorProxy({ hubPort: () => hubPort, allowedOrigins: ['http://localhost:5173'], now })
  const server = createServer((req, res) => {
    if (proxy.handles(req.url)) proxy.handle(req, res)
    else res.writeHead(418).end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (proxy.handles(req.url)) proxy.upgrade(req, socket, head)
    else socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, proxy, port: (server.address() as AddressInfo).port }
}

function get(port: number, path: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

function openSocket(port: number, path: string, origin?: string) {
  return new Promise<{ socket: WebSocket } | { refused: number }>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin === undefined ? {} : { origin })
    socket.on('open', () => resolve({ socket }))
    socket.on('unexpected-response', (_req, res) => resolve({ refused: res.statusCode ?? 0 }))
    socket.on('error', () => resolve({ refused: 0 }))
  })
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  })))
})

describe('simulator proxy', () => {
  it('passes a signed request for the screen through, without the caller\'s credentials', async () => {
    const helper = await startHelper()
    const manor = await startManor(helper.port)
    servers.push(helper.server, manor.server)
    const base = manor.proxy.streamBase()

    const answer = await get(manor.port, `${base}/helper/${UDID}/stream.mjpeg`, 'GET', { cookie: 'session=secret' })

    expect(answer.status).toBe(200)
    expect(answer.body).toBe(`helper:/helper/${UDID}/stream.mjpeg`)
    expect(answer.headers['cache-control']).toBe('no-store, no-transform')
    expect(helper.seen).toEqual([`GET /helper/${UDID}/stream.mjpeg host=127.0.0.1:${helper.port} cookie=`])
  })

  it('refuses a request without a valid ticket, and never reaches the helper', async () => {
    const helper = await startHelper()
    const manor = await startManor(helper.port)
    servers.push(helper.server, manor.server)
    const [, , ticket] = manor.proxy.streamBase().split('/')
    const forged = `${ticket!.split('.')[0]}.${'A'.repeat(32)}`

    expect((await get(manor.port, `/simulator/helper/${UDID}/stream.mjpeg`)).status).toBe(401)
    expect((await get(manor.port, `/simulator/nope/helper/${UDID}/stream.mjpeg`)).status).toBe(401)
    expect((await get(manor.port, `/simulator/${forged}/helper/${UDID}/stream.mjpeg`)).status).toBe(401)
    expect(await openSocket(manor.port, `/simulator/${forged}/helper/${UDID}/ws`)).toEqual({ refused: 401 })
    expect(helper.seen).toEqual([])
  })

  it('refuses an expired ticket', async () => {
    const helper = await startHelper()
    let at = 1_000_000
    const manor = await startManor(helper.port, () => at)
    servers.push(helper.server, manor.server)
    const base = manor.proxy.streamBase()
    at += SIMULATOR_TICKET_TTL_MS + 1

    expect((await get(manor.port, `${base}/helper/${UDID}/config`)).status).toBe(401)
    expect(helper.seen).toEqual([])
  })

  it('refuses every helper route that is not the screen, its size or its input, signed or not', async () => {
    const helper = await startHelper()
    const manor = await startManor(helper.port)
    servers.push(helper.server, manor.server)
    const base = manor.proxy.streamBase()

    for (const path of ['/api', '/exec', '/exec-ws', '/grid/api', '/grid/api/start', '/api/diagnostics', `/helper/${UDID}/ax`,
      `/helper/${UDID}/recording/start`, `/helper/${UDID}/stream.avcc`, `/helper/not-a-udid/stream.mjpeg`, `/helper/${UDID}/../../exec`, `/helper/${UDID}/%2e%2e/%2e%2e/exec`]) {
      expect((await get(manor.port, `${base}${path}`)).status, path).toBe(404)
    }
    expect((await get(manor.port, `${base}/helper/${UDID}/stream.mjpeg`, 'POST')).status).toBe(405)
    expect(await openSocket(manor.port, `${base}/exec-ws`)).toEqual({ refused: 404 })
    expect(helper.seen).toEqual([])
  })

  it('bridges the input socket with the helper\'s own origin, and refuses a foreign page', async () => {
    const helper = await startHelper()
    const manor = await startManor(helper.port)
    servers.push(helper.server, manor.server)
    const base = manor.proxy.streamBase()

    expect(await openSocket(manor.port, `${base}/helper/${UDID}/ws`, 'https://evil.example')).toEqual({ refused: 403 })
    const opened = await openSocket(manor.port, `${base}/helper/${UDID}/ws`, `http://127.0.0.1:${manor.port}`)
    if (!('socket' in opened)) throw new Error(`refused ${opened.refused}`)
    const reply = await new Promise<string>((resolve) => {
      opened.socket.on('message', (data) => resolve(String(data)))
      opened.socket.send('tap')
    })
    opened.socket.close()

    expect(reply).toBe('echo:tap')
    expect(helper.seen).toEqual([`WS /helper/${UDID}/ws origin=http://127.0.0.1:${helper.port}`])
  })

  it('ends open input sockets and voids handed-out paths on revoke', async () => {
    const helper = await startHelper()
    const manor = await startManor(helper.port)
    servers.push(helper.server, manor.server)
    const base = manor.proxy.streamBase()
    const opened = await openSocket(manor.port, `${base}/helper/${UDID}/ws`)
    if (!('socket' in opened)) throw new Error(`refused ${opened.refused}`)
    const closed = new Promise<void>((resolve) => opened.socket.on('close', () => resolve()))

    manor.proxy.revokeAll()

    await closed
    expect((await get(manor.port, `${base}/helper/${UDID}/config`)).status).toBe(401)
    expect((await get(manor.port, `${manor.proxy.streamBase()}/helper/${UDID}/config`)).status).toBe(200)
  })

  it('answers 503 while the helper is not running', async () => {
    const manor = await startManor(undefined)
    servers.push(manor.server)
    expect((await get(manor.port, `${manor.proxy.streamBase()}/helper/${UDID}/config`)).status).toBe(503)
  })
})
