import type { McpServerDraft } from '@manor/contracts'
import { mcpHttpUrl } from '@manor/contracts'
import { readOnlyToolNames, type McpProbeResult } from './probeResult.js'

/**
 * Speaks MCP over streamable HTTP, once, for the same reasons the stdio probe
 * exists: a URL that does not answer would otherwise become a silent missing
 * capability on the next turn, and `schemaChars` is what the persona form prices.
 *
 * Unparked 2026-08-20 for Figma's desktop server at `http://127.0.0.1:3845/mcp`.
 * Authentication values arrive already resolved from the host environment. The
 * registry and provider argv carry only the variable names.
 */

const PROTOCOL_VERSION = '2025-06-18'

/** A tools/list for a large connector is tens of kilobytes; anything near this is not MCP. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const toolShape = (serverName: string, tool: Record<string, unknown>) => ({
  name: `mcp__${serverName}__${String(tool['name'] ?? '')}`,
  description: tool['description'] ?? '',
  input_schema: tool['inputSchema'] ?? {},
})

interface HttpSession {
  url: string
  sessionId: string | null
  /** Negotiated on initialize, sent as MCP-Protocol-Version on every later request. */
  protocolVersion: string | null
  bearer?: string
  headers: Readonly<Record<string, string>>
}

export async function probeHttpMcpServer(
  draft: McpServerDraft,
  options: { timeoutMs?: number; bearer?: string; headers?: Readonly<Record<string, string>> } = {},
): Promise<McpProbeResult> {
  const url = mcpHttpUrl(draft)
  if (url === undefined) {
    throw new Error(`${draft.name} has no URL to probe.`)
  }
  const timeoutMs = options.timeoutMs ?? 20_000
  const session: HttpSession = {
    url,
    sessionId: null,
    protocolVersion: null,
    bearer: options.bearer,
    headers: options.headers ?? {},
  }

  try {
    const initialized = await rpc(
      session,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'manor', version: '0' },
        },
      },
      timeoutMs,
    )
    if (!isRecord(initialized) || typeof initialized['protocolVersion'] !== 'string' || initialized['protocolVersion'].length === 0) {
      throw new Error(`${url} did not speak MCP: initialize had no protocolVersion`)
    }
    session.protocolVersion = initialized['protocolVersion']
    const instructions = typeof initialized['instructions'] === 'string' ? initialized['instructions'] : ''

    await rpc(session, { jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs)

    const listed = await rpc(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, timeoutMs)
    if (!isRecord(listed) || !Array.isArray(listed['tools'])) {
      throw new Error(`${url} did not speak MCP: tools/list had no tools array`)
    }
    const tools = listed['tools'].filter(isRecord)
    const payload = tools.map((tool) => toolShape(draft.name, tool))
    const discovered: McpProbeResult = {
      tools: tools.map((tool) => String(tool['name'] ?? '')).filter((name) => name.length > 0),
      readOnlyTools: readOnlyToolNames(draft.name, tools),
      schemaChars: JSON.stringify(payload).length + instructions.length,
    }

    if (discovered.tools.includes('get_profile')) {
      const called = await rpc(
        session,
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_profile', arguments: {} } },
        timeoutMs,
      )
      if (isToolError(called)) {
        throw new Error(`${url} started, but get_profile could not verify its credential`)
      }
      return { ...discovered, verifiedBy: 'get_profile' }
    }

    return discovered
  } catch (error: unknown) {
    throw new Error(httpProbeMessage(url, error, timeoutMs))
  }
}

function isToolError(result: unknown): boolean {
  if (!isRecord(result)) return false
  if (result['isError'] === true) return true
  const content = Array.isArray(result['content']) ? result['content'] : []
  return content.some((item) => {
    if (!isRecord(item) || typeof item['text'] !== 'string') return false
    try {
      const parsed: unknown = JSON.parse(item['text'])
      return isRecord(parsed) && typeof parsed['error'] === 'string'
    } catch {
      return false
    }
  })
}

async function rpc(
  session: HttpSession,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const expectedId = typeof payload['id'] === 'number' ? payload['id'] : undefined
  const headers: Record<string, string> = {
    ...session.headers,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (session.sessionId !== null) headers['Mcp-Session-Id'] = session.sessionId
  if (session.protocolVersion !== null) headers['MCP-Protocol-Version'] = session.protocolVersion
  if (session.bearer !== undefined && session.bearer.length > 0) {
    headers.Authorization = `Bearer ${session.bearer}`
  }

  const response = await fetch(session.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (response.status === 401) {
    throw new Error(`${session.url} requires OAuth (HTTP 401)`)
  }

  const sessionId = response.headers.get('mcp-session-id')
  if (sessionId !== null && sessionId.length > 0) session.sessionId = sessionId

  const body = await readRpcBody(response, expectedId)
  if (expectedId === undefined) {
    if (body === undefined && response.ok) return undefined
    if (isRecord(body) && isRecord(body['error'])) {
      throw new Error(String(body['error']['message'] ?? `HTTP MCP error from ${session.url}`))
    }
    if (!response.ok) throw new Error(`${session.url} answered HTTP ${response.status}`)
    return undefined
  }

  if (body === undefined) {
    throw new Error(`${session.url} did not speak MCP: request ${expectedId} got HTTP ${response.status} with an empty body`)
  }
  const message = rpcMessageWithId(body, expectedId)
  if (message === undefined) {
    throw new Error(`${session.url} did not speak MCP: no JSON-RPC response for request ${expectedId}`)
  }
  if (isRecord(message['error'])) {
    throw new Error(String(message['error']['message'] ?? `HTTP MCP error from ${session.url}`))
  }
  if (!response.ok) throw new Error(`${session.url} answered HTTP ${response.status}`)
  if (!Object.prototype.hasOwnProperty.call(message, 'result')) {
    throw new Error(`${session.url} did not speak MCP: request ${expectedId} had no result`)
  }
  return message['result']
}

/**
 * Reads the body as it arrives. A streamable HTTP server may answer over SSE and
 * keep the stream open, so an SSE body resolves as soon as the event carrying
 * `expectedId` is complete, then the stream is cancelled.
 */
async function readRpcBody(response: Response, expectedId: number | undefined): Promise<unknown> {
  if (response.body === null) return undefined
  const contentType = response.headers.get('content-type') ?? ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  const isSse = () =>
    contentType.includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error(`HTTP MCP response exceeded ${MAX_RESPONSE_BYTES} bytes`)
      }
      text += decoder.decode(value, { stream: true })
      if (expectedId !== undefined && isSse()) {
        const messages = sseMessages(completeSseEvents(text))
        if (rpcMessageWithId(messages, expectedId) !== undefined) return messages
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  text += decoder.decode()
  if (text.trim().length === 0) return undefined
  if (isSse()) {
    const messages = sseMessages(normalizeSse(text))
    if (messages.length === 0) throw new Error('HTTP MCP SSE response had no JSON payload')
    return messages
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('HTTP MCP response was not JSON')
  }
}

// The SSE spec allows CR, LF or CRLF. Normalize so a CRLF stream does not look
// like one undivided block. Normalizing the whole buffer keeps a CRLF split
// across two chunks from reading as two line endings.
const normalizeSse = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

/** The part of a partial SSE buffer that ends in a blank line, i.e. finished events. */
function completeSseEvents(text: string): string {
  const normalized = normalizeSse(text)
  const end = normalized.lastIndexOf('\n\n')
  return end === -1 ? '' : normalized.slice(0, end)
}

/** SSE events in order. A server may send notifications before the JSON-RPC response. */
function sseMessages(normalized: string): unknown[] {
  const messages: unknown[] = []
  for (const block of normalized.split('\n\n')) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (dataLines.length === 0) continue
    const data = dataLines.join('\n').trim()
    if (data.length === 0 || data === '[DONE]') continue
    try {
      messages.push(JSON.parse(data) as unknown)
    } catch {
      continue
    }
  }
  return messages
}

function rpcMessageWithId(body: unknown, expectedId: number): Record<string, unknown> | undefined {
  const candidates = Array.isArray(body) ? body : [body]
  return candidates.find((item): item is Record<string, unknown> => isRecord(item) && item['id'] === expectedId)
}

function httpProbeMessage(url: string, error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `${url} did not answer within ${timeoutMs}ms`
    }
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(error.message)) {
      return `could not reach ${url}`
    }
    if (
      error.message.includes(url) ||
      error.message.includes('HTTP MCP') ||
      error.message.includes('did not speak MCP') ||
      error.message.includes('requires OAuth') ||
      error.message.includes('started, but')
    ) {
      return error.message
    }
    return `could not reach ${url}: ${error.message}`
  }
  return `could not reach ${url}`
}
