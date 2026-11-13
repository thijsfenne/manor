import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { McpServerConfig } from '@manor/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { EffectCapabilities, InvalidEffectCapabilityError } from '../src/effectCapability.js'
import type { EffectProxyUpstream } from '../src/mcp/effectProxyAttachment.js'
import { calendarMcpDraft } from '../src/mcp/calendarRegistration.js'
import { mailMcpDraft } from '../src/mcp/mailAttachment.js'
import { remindersMcpDraft } from '../src/mcp/remindersRegistration.js'
import { MCP_CAPABILITY_HEADER, McpHttpHost } from '../src/mcp/httpHost.js'
import { StdioPool, sharesStdioProcess, stdioConnectorEndpoint } from '../src/mcp/stdioPool.js'

// A stdio MCP server that logs what reaches it, answers with its pid, and can hang or crash on request.
const FAKE = `
const fs = require('fs')
const out = (x) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n')
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  const p = m.params || {}
  fs.appendFileSync(process.env.FAKE_LOG, process.pid + ' ' + m.method + ' ' + (p.name || p.requestId || '') + '\\n')
  if (m.id === undefined) return
  if (m.method === 'initialize' && process.env.FAKE_HANG === '1') return
  if (m.method === 'initialize') return out({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } })
  if (p.name === 'slow') return
  if (p.name === 'crash') { process.stderr.write('lost ' + process.env.FAKE_TOKEN + '\\n'); process.exit(3) }
  out({ id: m.id, result: { content: [{ type: 'text', text: process.pid + ':' + process.env.FAKE_TOKEN + ((p.arguments || {}).marker ? ':' + p.arguments.marker : '') }] } })
})`

const row: McpServerConfig = {
  id: 'mcp_mail', name: 'mail', command: process.execPath, args: ['-e', FAKE], envKeys: ['FAKE_TOKEN', 'FAKE_LOG', 'FAKE_HANG'],
  description: '', writes: true, effectPolicy: 'confirm_writes', tools: ['send', 'slow', 'crash'], readOnlyTools: [], schemaChars: 0,
}
const upstream: EffectProxyUpstream = { name: 'mail', command: row.command, args: row.args, envKeys: row.envKeys, httpHeaders: {} }
const CAPABILITY_ENV = 'MANOR_EFFECT_CAPABILITY_TEST'

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

type Reply = { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } }

describe('StdioPool', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => { for (const step of cleanup.splice(0)) step() })

  async function setup(timing: { idleMs?: number; startMs?: number; callMs?: number } = {}) {
    const log = path.join(mkdtempSync(path.join(tmpdir(), 'manor-pool-')), 'calls.log')
    const capabilities = new EffectCapabilities()
    const brokered: string[] = []
    const broker = createServer(async (request, response) => {
      const payload = await body(request)
      response.setHeader('content-type', 'application/json')
      try {
        const effect = capabilities.take(String(request.headers['x-manor-effect-capability']), String(payload.tool))
        brokered.push(`${effect.chatId}:${String(payload.tool)}`)
        response.end(JSON.stringify({ approved: true }))
      } catch (error) {
        response.writeHead(error instanceof InvalidEffectCapabilityError ? 404 : 403)
        response.end(JSON.stringify({ error: 'Not found.' }))
      }
    })
    const host = new McpHttpHost('')
    const hostServer = createServer((request, response) => { void host.handle(request, response) })
    const pool = new StdioPool(timing)
    cleanup.push(() => { pool.close(); broker.close(); hostServer.close() })
    const brokerUrl = await listen(broker)
    const origin = await listen(hostServer)

    const mount = (chatId: string, turnId: string, token = 'secret-one', hang = '0') => {
      const capability = capabilities.issue({ chatId, agentId: 'sage', turnId, canApprove: true }, row)
      const pooled = pool.lease(row.id, upstream, { FAKE_TOKEN: token, FAKE_LOG: log, FAKE_HANG: hang })
      host.serve({ server: row, disabledTools: [], runtimeEnv: { [CAPABILITY_ENV]: capability } }, CAPABILITY_ENV, stdioConnectorEndpoint(pooled, brokerUrl), turnId)
      return { capability, pooled }
    }
    const post = async (capability: string | undefined, message: Record<string, unknown>) => {
      const response = await fetch(`${origin}/mcp/mail`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(capability === undefined ? {} : { [MCP_CAPABILITY_HEADER]: capability }) },
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      })
      return { status: response.status, reply: (response.status === 202 ? {} : await response.json()) as Reply }
    }
    const call = (capability: string | undefined, name: string, id = 1, marker?: string) =>
      post(capability, { id, method: 'tools/call', params: { name, arguments: marker === undefined ? {} : { marker } } })
    const seen = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
    return { host, pool, capabilities, brokered, mount, post, call, seen }
  }

  it('serves every thread from one process, each call as its own thread', async () => {
    const { brokered, mount, call, post, seen } = await setup()
    const a = mount('chat_a', 'turn_a')
    const b = mount('chat_b', 'turn_b')
    expect(a.pooled).toBe(b.pooled)

    expect((await post(a.capability, { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).reply)
      .toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'fake' } } })
    const [first, second] = await Promise.all([call(a.capability, 'send', 1, 'from-a'), call(b.capability, 'send', 1, 'from-b')])
    const [pidA, , markA] = first.reply.result?.content[0]?.text.split(':') ?? []
    const [pidB, , markB] = second.reply.result?.content[0]?.text.split(':') ?? []
    expect([pidA === pidB, markA, markB]).toEqual([true, 'from-a', 'from-b'])
    expect(brokered.sort()).toEqual(['chat_a:send', 'chat_b:send'])
    expect(seen().filter((line) => line.endsWith('initialize '))).toHaveLength(1)
  })

  it('refuses a write without a capability or with one the broker never issued', async () => {
    const { brokered, mount, call, seen } = await setup()
    const a = mount('chat_a', 'turn_a')
    expect((await call(undefined, 'send')).status).toBe(404)
    expect((await call(`${a.capability}x`, 'send')).status).toBe(404)
    expect(brokered).toEqual([])
    expect(seen()).toEqual([])
  })

  it('cancels a running call and drops a queued one when the turn closes', async () => {
    const { host, brokered, mount, call, seen } = await setup()
    const a = mount('chat_a', 'turn_a')
    const slow = call(a.capability, 'slow', 1)
    const queued = call(a.capability, 'send', 2)
    for (let i = 0; i < 100 && !seen().some((line) => line.endsWith('tools/call slow')); i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    host.closeTurn('turn_a')
    expect((await slow).reply.result).toEqual({ isError: true, content: [{ type: 'text', text: 'This turn has ended.' }] })
    expect((await queued).reply.result).toEqual({ isError: true, content: [{ type: 'text', text: 'This turn has ended.' }] })
    expect(brokered).toEqual(['chat_a:slow'])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen().some((line) => / notifications\/cancelled manor_\d+$/.test(line))).toBe(true)
    expect(seen().some((line) => line.endsWith('tools/call send'))).toBe(false)
  })

  it('reports a crash without the secret and starts again on the next call', async () => {
    const { mount, call } = await setup()
    const a = mount('chat_a', 'turn_a', 'tok-very-secret')
    const crashed = await call(a.capability, 'crash')
    expect(crashed.reply.result).toEqual({ isError: true, content: [{ type: 'text', text: 'mail stopped (exit 3).' }] })
    const again = await call(a.capability, 'send', 2)
    expect(again.reply.result?.content[0]?.text).toMatch(/^\d+:tok-very-secret$/)
  })

  it('keeps rows with other secrets apart and stops an idle process', async () => {
    const { mount, call, seen } = await setup({ idleMs: 50 })
    const a = mount('chat_a', 'turn_a', 'one')
    const b = mount('chat_b', 'turn_b', 'two')
    expect(a.pooled).not.toBe(b.pooled)
    const before = (await call(a.capability, 'send')).reply.result?.content[0]?.text
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(a.pooled.running).toBe(false)
    const after = (await call(a.capability, 'send', 2)).reply.result?.content[0]?.text
    expect(after?.split(':')[0]).not.toBe(before?.split(':')[0])
    expect(seen().filter((line) => line.endsWith('initialize '))).toHaveLength(2)
  })

  it('drops a queued call the client cancelled before it reached the broker', async () => {
    const { brokered, mount, call, post, seen } = await setup()
    const a = mount('chat_a', 'turn_a')
    const slow = call(a.capability, 'slow', 1)
    const queued = call(a.capability, 'send', 2)
    for (let i = 0; i < 100 && !seen().some((line) => line.endsWith('tools/call slow')); i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    await post(a.capability, { method: 'notifications/cancelled', params: { requestId: 2 } })
    await post(a.capability, { method: 'notifications/cancelled', params: { requestId: 1 } })
    expect((await queued).reply.result?.content[0]?.text).toBe('This turn has ended.')
    expect((await slow).reply.result?.content[0]?.text).toBe('This turn has ended.')
    expect(brokered).toEqual(['chat_a:slow'])
  })

  it('stops an upstream that never initializes and tries again on the next call', async () => {
    const { mount, call, seen } = await setup({ startMs: 300 })
    const a = mount('chat_a', 'turn_a', 'one', '1')
    expect((await call(a.capability, 'send')).reply.result?.isError).toBe(true)
    expect(a.pooled.running).toBe(false)
    expect((await call(a.capability, 'send', 2)).reply.result?.isError).toBe(true)
    expect(seen().filter((line) => line.endsWith('initialize '))).toHaveLength(2)
  })

  it('stops a process stuck on one call and starts a fresh one for the next', async () => {
    const { mount, call, seen } = await setup({ callMs: 200 })
    const a = mount('chat_a', 'turn_a')
    const first = (await call(a.capability, 'send', 1)).reply.result?.content[0]?.text
    expect((await call(a.capability, 'slow', 2)).reply.result).toEqual({ isError: true, content: [{ type: 'text', text: 'mail did not answer in time.' }] })
    expect(a.pooled.running).toBe(false)
    const next = (await call(a.capability, 'send', 3)).reply.result?.content[0]?.text
    expect(next?.split(':')[0]).not.toBe(first?.split(':')[0])
    expect(seen().filter((line) => line.endsWith('initialize '))).toHaveLength(2)
  })

  it('never starts a process again once the pool closed', async () => {
    const { pool, mount, call } = await setup()
    const a = mount('chat_a', 'turn_a')
    expect((await call(a.capability, 'send')).reply.result?.isError).toBeUndefined()
    pool.close()
    expect((await call(a.capability, 'send', 2)).reply.result?.content[0]?.text).toBe('mail is closed.')
    expect(a.pooled.running).toBe(false)
    expect(() => pool.lease(row.id, upstream, {})).toThrow('Manor is shutting down.')
  })
})

describe('sharesStdioProcess', () => {
  const attached = (draft: { name: string; command: string; args: string[] }) => ({ server: { ...row, ...draft }, disabledTools: [] })
  it('shares only Manor\'s own stdio servers on this runtime', () => {
    const own = [mailMcpDraft(), calendarMcpDraft(), remindersMcpDraft()]
    expect(own.map((draft) => sharesStdioProcess(attached(draft)))).toEqual(own.map(() => true))
    expect(sharesStdioProcess(attached({ ...mailMcpDraft(), args: ['/elsewhere/mailMcp.mjs'] }))).toBe(false)
    expect(sharesStdioProcess(attached({ name: 'mail', command: 'npx', args: ['some-mail-mcp'] }))).toBe(false)
    expect(sharesStdioProcess(attached({ name: 'supabase', command: 'npx', args: ['@supabase/mcp-server-supabase'] }))).toBe(false)
    expect(sharesStdioProcess({ ...attached(mailMcpDraft()), server: { ...attached(mailMcpDraft()).server, url: 'https://example.test/mcp' } })).toBe(false)
  })
})
