import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { EffectProxyUpstream } from '../src/mcp/effectProxyAttachment.js'

const PROXY = fileURLToPath(new URL('../src/mcp/effectProxyMcp.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
const LINK = 'https://connect.composio.dev/link/lk_single_use'

type Body = Record<string, unknown>

function jsonServer(answer: (body: Body, response: import('node:http').ServerResponse) => void): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => answer(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body, response))
  })
}

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No port')
  return `http://127.0.0.1:${address.port}`
}

describe('connect cards through the effect proxy', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => { for (const step of cleanup.splice(0)) step() })

  async function proxy(upstream: EffectProxyUpstream, brokerUrl: string) {
    const child = spawn(process.execPath, [TSX, PROXY,
      '--broker-url', brokerUrl, '--capability-env', 'MANOR_EFFECT_TEST',
      '--upstream', Buffer.from(JSON.stringify(upstream)).toString('base64url'),
    ], { env: { ...process.env, MANOR_EFFECT_TEST: 'test', FAKE_COMPOSIO_KEY: 'ak_test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    cleanup.push(() => child.kill('SIGKILL'))
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    return async (id: number, method: string, params: unknown): Promise<Body> => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      for (;;) {
        const next = await lines.next()
        if (next.done) throw new Error(`proxy closed before ${id}`)
        const parsed = JSON.parse(next.value) as Body
        if (parsed.id === id) return parsed
      }
    }
  }

  it('hands a Composio sign-in link to a card and keeps it out of the model result', async () => {
    const connects: Body[] = []
    const upstreamCalls: string[] = []
    const broker = jsonServer((body, response) => {
      if (body.connect !== undefined) connects.push(body.connect as Body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body.env === true ? { env: {} } : body.connect !== undefined ? { outcome: { status: 'pending' } } : { approved: true }))
    })
    const upstream = jsonServer((body, response) => {
      const params = body.params as { name?: string } | undefined
      if (params?.name !== undefined) upstreamCalls.push(params.name)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'composio', version: '0' } }
        : { content: [{ type: 'text', text: JSON.stringify({ data: { results: { gmail: { redirect_url: LINK, connected_account_id: 'ca_new' } } } }) }] } }))
    })
    const [brokerUrl, upstreamUrl] = await Promise.all([listen(broker), listen(upstream)])
    cleanup.push(() => { broker.close(); upstream.close() })
    const call = await proxy({ name: 'composio', command: '', args: [], envKeys: ['FAKE_COMPOSIO_KEY'], httpHeaders: { 'x-api-key': 'FAKE_COMPOSIO_KEY' }, url: upstreamUrl }, brokerUrl)

    await call(1, 'initialize', { protocolVersion: '2025-06-18' })
    const reply = await call(2, 'tools/call', { name: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { toolkits: [{ name: 'gmail', alias: 'personal' }] } })
    expect(JSON.stringify(reply)).not.toContain('composio.dev')
    expect(JSON.stringify(reply)).toContain('connect card for gmail (personal)')
    expect(connects).toEqual([{ kind: 'composio', toolkit: 'gmail', alias: 'personal', accountId: 'ca_new', url: LINK }])

    const refused = await call(3, 'tools/call', { name: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { toolkits: [{ name: 'slack' }] } })
    expect(refused).toMatchObject({ result: { isError: true } })
    expect(upstreamCalls).toEqual(['COMPOSIO_MANAGE_CONNECTIONS'])
  })

  it('asks for one MCP login card when a remote row answers 401', async () => {
    const connects: Body[] = []
    const broker = jsonServer((body, response) => {
      if (body.connect !== undefined) connects.push(body.connect as Body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body.env === true ? { env: {} } : { outcome: { status: 'pending' } }))
    })
    const upstream = jsonServer((_body, response) => { response.writeHead(401); response.end() })
    const [brokerUrl, upstreamUrl] = await Promise.all([listen(broker), listen(upstream)])
    cleanup.push(() => { broker.close(); upstream.close() })
    const call = await proxy({ name: 'figma', command: '', args: [], envKeys: [], httpHeaders: {}, url: upstreamUrl }, brokerUrl)

    expect(await call(1, 'initialize', { protocolVersion: '2025-06-18' })).toMatchObject({ error: { message: 'figma requires login.' } })
    await call(2, 'tools/list', {})
    await expect.poll(() => connects).toEqual([{ kind: 'mcp_oauth' }])
  })
})
