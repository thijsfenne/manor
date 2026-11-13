import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AttachedMcpServer, McpServerConfig } from '@manor/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { EffectCapabilities, InvalidEffectCapabilityError } from '../src/effectCapability.js'
import { effectProxyUpstream } from '../src/mcp/effectProxyAttachment.js'
import { HttpConnector } from '../src/mcp/httpConnector.js'
import { MCP_CAPABILITY_HEADER, McpHttpHost, connectorEndpoint, toolEndpoint } from '../src/mcp/httpHost.js'
import { toolServerRpc } from '../src/mcp/stdio.js'

const CAPABILITY_ENV = 'MANOR_EFFECT_CAPABILITY_TEST'

const gmail = (url: string): McpServerConfig => ({
  id: 'mcp_gmail',
  name: 'gmail',
  command: '',
  args: [],
  envKeys: [],
  url,
  description: '',
  writes: true,
  effectPolicy: 'confirm_writes',
  tools: ['get_message', 'send_message'],
  readOnlyTools: ['get_message'],
  schemaChars: 0,
})

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No port')
  return `http://127.0.0.1:${address.port}`
}

describe('McpHttpHost', () => {
  const servers: Server[] = []
  afterEach(() => { for (const server of servers.splice(0)) server.close() })

  /** Two threads on one HTTP connector; the broker resolves each call's capability like `/internal/effect-approval`. */
  async function setup() {
    const capabilities = new EffectCapabilities()
    const brokered: string[] = []
    const upstreamCalls: string[] = []
    const broker = createServer(async (request, response) => {
      const payload = await body(request)
      response.setHeader('content-type', 'application/json')
      try {
        if (payload.env === true) {
          response.end(JSON.stringify({ env: capabilities.takeEnv(String(request.headers['x-manor-effect-capability'])) }))
          return
        }
        const effect = capabilities.take(String(request.headers['x-manor-effect-capability']), String(payload.tool))
        brokered.push(`${effect.chatId}:${String(payload.tool)}`)
        response.end(JSON.stringify({ approved: true }))
      } catch (error) {
        response.writeHead(error instanceof InvalidEffectCapabilityError ? 404 : 403)
        response.end(JSON.stringify({ error: 'Not found.' }))
      }
    })
    const upstream = createServer(async (request, response) => {
      const message = await body(request)
      if (message.method === 'tools/call') upstreamCalls.push(String((message.params as { name: string }).name))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'sent' }] } }))
    })
    servers.push(broker, upstream)
    const brokerUrl = await listen(broker)
    const config = gmail(`${await listen(upstream)}/mcp`)

    const hostServer = createServer((request, response) => { void host.handle(request, response) })
    servers.push(hostServer)
    const origin = await listen(hostServer)
    const host = new McpHttpHost(origin)

    const mount = (chatId: string, turnId: string) => {
      const token = capabilities.issue({ chatId, agentId: 'sage', turnId, canApprove: true }, config)
      const attached: AttachedMcpServer = { server: config, disabledTools: [], runtimeEnv: { [CAPABILITY_ENV]: token } }
      const served = host.serve(attached, CAPABILITY_ENV, connectorEndpoint(new HttpConnector(effectProxyUpstream(attached), brokerUrl, () => undefined)), turnId)
      return { token, url: served.server.url! }
    }

    const call = async (url: string, capability: string | undefined, tool = 'send_message') => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(capability === undefined ? {} : { [MCP_CAPABILITY_HEADER]: capability }) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { to: 'x' } } }),
      })
      return { status: response.status, payload: await response.json() as Record<string, unknown> }
    }
    return { host, capabilities, brokered, upstreamCalls, mount, call, origin }
  }

  it('acts as the thread whose capability the call carries, never as another', async () => {
    const { brokered, upstreamCalls, mount, call } = await setup()
    const a = mount('chat_a', 'turn_a')
    const b = mount('chat_b', 'turn_b')
    expect(a.url).toBe(b.url)
    expect(a.url).not.toContain(a.token)

    expect((await call(a.url, a.token)).status).toBe(200)
    expect((await call(b.url, b.token)).status).toBe(200)
    expect(brokered).toEqual(['chat_a:send_message', 'chat_b:send_message'])
    expect(upstreamCalls).toEqual(['send_message', 'send_message'])
  })

  it('refuses a write without a capability or with one it never issued', async () => {
    const { brokered, upstreamCalls, mount, call } = await setup()
    const a = mount('chat_a', 'turn_a')

    expect(await call(a.url, undefined)).toEqual({ status: 404, payload: { error: 'Not found.' } })
    expect((await call(a.url, '')).status).toBe(404)
    expect((await call(a.url, `${a.token}x`)).status).toBe(404)
    expect(brokered).toEqual([])
    expect(upstreamCalls).toEqual([])
  })

  it('refuses another thread\'s capability once that thread\'s turn closed, and on another mount', async () => {
    const { host, capabilities, brokered, upstreamCalls, mount, call, origin } = await setup()
    const a = mount('chat_a', 'turn_a')
    const b = mount('chat_b', 'turn_b')
    const interaction = host.serve(
      { server: { ...gmail(''), id: 'builtin_manor', name: 'manor', url: undefined }, disabledTools: [], runtimeEnv: { [CAPABILITY_ENV]: 'manor-token' } },
      CAPABILITY_ENV,
      toolEndpoint({ name: 'manor', tools: [], failureMessage: 'failed', callTool: async () => [] }),
      'turn_b',
    )
    // Thread B's built-in capability does not open its own connector path.
    expect((await call(`${origin}/mcp/gmail`, 'manor-token')).status).toBe(404)
    expect((await call(interaction.server.url!, b.token)).status).toBe(404)

    host.closeTurn('turn_b')
    capabilities.closeTurn('turn_b')
    expect((await call(b.url, b.token)).status).toBe(404)
    expect((await call(interaction.server.url!, 'manor-token')).status).toBe(404)
    expect((await call(a.url, a.token)).status).toBe(200)
    expect(brokered).toEqual(['chat_a:send_message'])
    expect(upstreamCalls).toEqual(['send_message'])
  })

  it('follows a rekey and still unmounts by the issued token', async () => {
    const { host, mount, call } = await setup()
    const a = mount('chat_a', 'turn_a')
    expect(host.rekey(a.token, 'live-token')).toBe('rekeyed')
    expect((await call(a.url, a.token)).status).toBe(404)
    host.unmount(a.token)
    expect((await call(a.url, 'live-token')).status).toBe(404)
  })

  it('answers only POST and keeps a notification without a body', async () => {
    const { mount, origin } = await setup()
    const a = mount('chat_a', 'turn_a')
    expect((await fetch(`${origin}/mcp/gmail`)).status).toBe(405)
    const note = await fetch(a.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [MCP_CAPABILITY_HEADER]: a.token },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(note.status).toBe(202)
  })

  it('never runs a call still queued when its turn closed', async () => {
    const { host } = await setup()
    const ran: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    let arrived!: () => void
    const reached = new Promise<void>((resolve) => { arrived = resolve })
    const endpoint = toolEndpoint({ name: 'work', tools: [], failureMessage: 'failed', callTool: async (name) => {
      ran.push(String(name))
      if (name === 'slow') { entered(); await gate }
      return [{ type: 'text', text: 'done' }]
    } })
    const served = host.serve(
      { server: { ...gmail(''), id: 'builtin_work', name: 'work', url: undefined }, disabledTools: [], runtimeEnv: { [CAPABILITY_ENV]: 'held' } },
      CAPABILITY_ENV,
      // Signals once the second call is queued behind the first, so the turn closes on it then.
      (message, capability, closed) => {
        const answer = endpoint(message, capability, closed)
        if (message.id === 2) arrived()
        return answer
      },
      'turn_a',
    )
    const post = (id: number, name: string) => fetch(served.server.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [MCP_CAPABILITY_HEADER]: 'held' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }),
    }).then((response) => response.json() as Promise<{ result: { isError?: boolean; content: { text: string }[] } }>)
    const slow = post(1, 'slow')
    await blocked
    const queued = post(2, 'start_work')
    await reached
    host.closeTurn('turn_a')
    release()
    expect((await slow).result.content[0]?.text).toBe('done')
    expect((await queued).result).toEqual({ isError: true, content: [{ type: 'text', text: 'This turn has ended.' }] })
    expect(ran).toEqual(['slow'])
  })

  it('refuses a connector call whose turn closed before the broker is asked', async () => {
    const { brokered, upstreamCalls } = await setup()
    const connector = new HttpConnector(effectProxyUpstream({ server: gmail('http://127.0.0.1:1/mcp'), disabledTools: [] }), 'http://127.0.0.1:1', () => undefined)
    const closed = new AbortController()
    closed.abort()
    expect(await connector.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'send_message', arguments: {} } }, 'held', closed.signal))
      .toEqual([{ jsonrpc: '2.0', id: 9, result: { isError: true, content: [{ type: 'text', text: 'This turn has ended.' }] } }])
    expect(brokered).toEqual([])
    expect(upstreamCalls).toEqual([])
  })

  it('opens its own upstream session when a live client takes over the next turn', async () => {
    const seen: string[] = []
    const upstream = createServer(async (request, response) => {
      const message = await body(request)
      const session = request.headers['mcp-session-id']
      seen.push(`${String(message.method)}:${String(session ?? '-')}`)
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `s${seen.length}` })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }))
        return
      }
      if (session === undefined) { response.writeHead(400).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }))
    })
    const broker = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ env: {}, approved: true }))
    })
    servers.push(upstream, broker)
    const attached: AttachedMcpServer = { server: gmail(`${await listen(upstream)}/mcp`), disabledTools: [], runtimeEnv: { [CAPABILITY_ENV]: 'next-turn' } }
    // This turn's connector never sees the client's initialize; the live Codex process sent it a turn ago.
    const endpoint = connectorEndpoint(new HttpConnector(effectProxyUpstream(attached), await listen(broker), () => undefined))
    const call = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_message', arguments: {} } }
    const open = new AbortController().signal
    expect(await endpoint(call, 'next-turn', open)).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [] } })
    expect(await endpoint({ ...call, id: 8 }, 'next-turn', open)).toMatchObject({ id: 8, result: { content: [] } })
    expect(seen).toEqual(['initialize:-', 'notifications/initialized:s1', 'tools/call:s1', 'tools/call:s1'])
  })
})

describe('toolServerRpc', () => {
  it('answers in request order and starts a concurrent call only after the serial calls before it', async () => {
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const rpc = toolServerRpc({
      name: 'manor', tools: [], failureMessage: 'failed',
      concurrent: (name) => name === 'delegate_task',
      callTool: async (name) => {
        started.push(String(name))
        if (name === 'slow') await gate
        return []
      },
    })
    const call = (id: number, name: string) => rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }, 'token')
    const slow = call(1, 'slow')
    const unknown = rpc({ jsonrpc: '2.0', id: 2, method: 'unknown' }, 'token')
    const delegated = call(3, 'delegate_task')
    const after = call(4, 'after')
    const order: unknown[] = []
    for (const reply of [slow, unknown, delegated, after]) void reply.then((value) => order.push(value?.id))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toEqual(['slow'])
    release()
    await Promise.all([slow, unknown, delegated, after])
    expect(started).toEqual(['slow', 'delegate_task', 'after'])
    expect(order).toEqual([1, 2, 3, 4])
  })
})
