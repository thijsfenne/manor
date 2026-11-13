import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttachedMcpServer } from '@manor/contracts'
import { rekeyEntry, type RekeyResult } from '../capabilityRekey.js'
import { isRecord, toolServerRpc, type JsonRecord, type McpToolServer } from './stdio.js'
import type { HttpConnector } from './httpConnector.js'

/** Carries the turn's capability. Every driver fills it from an env var it was granted, never from argv or a URL. */
export const MCP_CAPABILITY_HEADER = 'x-manor-mcp-capability'
export const MCP_HTTP_PATH_PREFIX = '/mcp/'

const BODY_LIMIT_BYTES = 8 * 1024 * 1024
/**
 * A call still running after this answers as an event stream instead. ask_user and a
 * subagent wait last minutes, and a client's fetch gives up on response headers that
 * long in coming (undici's default is 300s); comments keep the stream alive.
 */
const STREAM_AFTER_MS = 2_000
const KEEPALIVE_MS = 15_000

/**
 * Answers one JSON-RPC message; undefined for a notification. The capability is the
 * header the call arrived with; `closed` aborts once its mount is gone, and work still
 * waiting inside the endpoint must then not run.
 */
export type McpEndpoint = (message: JsonRecord, capability: string, closed: AbortSignal) => Promise<JsonRecord | undefined>

interface Mount {
  name: string
  turnId: string | undefined
  endpoint: McpEndpoint
  closed: AbortController
}

export const toolEndpoint = (server: McpToolServer): McpEndpoint => toolServerRpc(server)

/** Hands the client only the answer to its own request; upstream notifications have no stream to ride. */
export const connectorEndpoint = (connector: HttpConnector): McpEndpoint => async (message, capability, closed) => {
  const replies = await connector.handle(message, capability, closed)
  if (message.id === undefined || message.id === null) return undefined
  const reply = replies.find((item) => isRecord(item) && item.id === message.id)
  return isRecord(reply) ? reply : { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'The connector sent no answer.' } }
}

/**
 * Manor's own MCP servers and its HTTP connectors, served from the Manor server
 * itself so a turn costs no process per server.
 *
 * A mount is keyed by the turn's capability token: the header names the mount, the
 * path only has to agree with it. A token from one turn therefore reaches only that
 * turn's mount, and every call still crosses the same broker route, which resolves
 * the token again. Mounts go when their turn closes, like the capabilities do.
 */
export class McpHttpHost {
  private readonly mounts = new Map<string, Mount>()
  /** Issued token to the token a live process holds it under, so `unmount` still finds it. */
  private readonly moved = new Map<string, string>()

  constructor(private readonly origin: string) {}

  /**
   * Swaps a stdio attachment for this host's endpoint. The model-facing name and tool
   * list stay; the CLI receives only the capability, under the same env key.
   */
  serve(attached: AttachedMcpServer, capabilityEnv: string, endpoint: McpEndpoint, turnId?: string): AttachedMcpServer {
    const capability = attached.runtimeEnv?.[capabilityEnv]
    if (capability === undefined || capability === '') throw new Error(`${attached.server.name} has no capability to serve.`)
    this.mounts.set(capability, { name: attached.server.name, turnId, endpoint, closed: new AbortController() })
    return {
      server: {
        ...attached.server,
        command: '',
        args: [],
        envKeys: [],
        url: `${this.origin}${MCP_HTTP_PATH_PREFIX}${encodeURIComponent(attached.server.name)}`,
        httpHeaders: [{ name: MCP_CAPABILITY_HEADER, envKey: capabilityEnv }],
      },
      disabledTools: [...attached.disabledTools],
      runtimeEnv: { [capabilityEnv]: capability },
    }
  }

  /** A built-in's stdio attachment served here instead, configured by the same flags. */
  serveBuiltIn(
    attached: AttachedMcpServer,
    capabilityEnv: string,
    create: (argv: readonly string[]) => McpToolServer,
    turnId?: string,
  ): AttachedMcpServer {
    return this.serve(attached, capabilityEnv, toolEndpoint(create(attached.server.args)), turnId)
  }

  unmount(capability: string): void {
    const key = this.moved.get(capability) ?? capability
    this.mounts.get(key)?.closed.abort()
    this.mounts.delete(key)
    this.moved.delete(capability)
  }

  closeTurn(turnId: string): void {
    for (const [capability, mount] of this.mounts) {
      if (mount.turnId !== turnId) continue
      mount.closed.abort()
      this.mounts.delete(capability)
    }
    for (const [from, to] of this.moved) {
      if (!this.mounts.has(to)) this.moved.delete(from)
    }
  }

  /** Follows a capability onto the token a live provider process holds; see `rekeyEntry`. */
  rekey(from: string, to: string): RekeyResult {
    const result = rekeyEntry(this.mounts, from, to)
    if (result === 'rekeyed' && from !== to) this.moved.set(from, to)
    return result
  }

  handles(url: string | undefined): boolean {
    return url?.startsWith(MCP_HTTP_PATH_PREFIX) === true
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.on('error', () => undefined)
    if (!isLoopback(request.socket.remoteAddress)) return reply(response, 404, { error: 'Not found.' })
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Only POST is served here.' }))
      return
    }
    const raw = request.headers[MCP_CAPABILITY_HEADER]
    const capability = Array.isArray(raw) ? raw[0] : raw
    const mount = capability === undefined || capability === '' ? undefined : this.mounts.get(capability)
    if (mount === undefined || mount.name !== mountName(request.url)) return reply(response, 404, { error: 'Not found.' })

    let message: unknown
    try {
      message = JSON.parse(await readBody(request))
    } catch {
      return reply(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } })
    }
    // The turn may have closed while the body arrived, and a rekey may have handed its token to the next turn.
    if (this.mounts.get(capability!) !== mount) return reply(response, 404, { error: 'Not found.' })
    if (!isRecord(message) || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return reply(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'One JSON-RPC message per request.' } })
    }
    const id = message.id
    const answer = mount.endpoint(message, capability!, mount.closed.signal).catch((error: unknown): JsonRecord => ({
      jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : 'The Manor tool failed.' },
    }))
    if (id === undefined || id === null) {
      await answer
      response.writeHead(202)
      response.end()
      return
    }

    const streams = String(request.headers.accept ?? '').includes('text/event-stream')
    let keepalive: NodeJS.Timeout | undefined
    const opening = streams ? setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.flushHeaders()
      keepalive = setInterval(() => response.write(': keepalive\n\n'), KEEPALIVE_MS)
    }, STREAM_AFTER_MS) : undefined
    const stopTimers = () => {
      clearTimeout(opening)
      clearInterval(keepalive)
    }
    response.once('close', stopTimers)
    const result = await answer
    stopTimers()
    if (response.destroyed) return
    if (response.headersSent) response.end(`event: message\ndata: ${JSON.stringify(result)}\n\n`)
    else reply(response, 200, result)
  }
}

function mountName(url: string | undefined): string | undefined {
  const path = (url ?? '').split('?')[0] ?? ''
  if (!path.startsWith(MCP_HTTP_PATH_PREFIX)) return undefined
  try {
    return decodeURIComponent(path.slice(MCP_HTTP_PATH_PREFIX.length))
  } catch {
    return undefined
  }
}

const isLoopback = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) throw new Error('MCP request is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function reply(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}
