import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EffectCapabilities } from '../src/effectCapability.js'
import type { EffectProxyUpstream } from '../src/mcp/effectProxyAttachment.js'

const PROXY = fileURLToPath(new URL('../src/mcp/effectProxyMcp.ts', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../fixtures/fakeMcpServer.mjs', import.meta.url))
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))

describe('the stdio effect proxy', () => {
  const children: ReturnType<typeof spawn>[] = []

  afterEach(() => {
    for (const child of children) child.kill('SIGKILL')
  })

  it.each(['stdio', 'http'])('binds Executor continuations through the %s transport', async (transport) => {
    const seen: { tool: string; reviewArguments: unknown }[] = []
    let deny = false
    const broker = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          env?: boolean; tool: string; reviewArguments: unknown
        }
        if (body.env !== true) seen.push(body)
        response.writeHead(deny ? 403 : 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body.env === true ? { env: {} } : deny ? { error: 'Denied' } : {
          approved: true, ...(body.tool === 'execute' ? { continuation: 'fixture-permit' } : {}),
        }))
      })
    })
    const upstreamHttp = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; params?: { name?: string } }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.id === 1 ? {
          protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' },
        } : { structuredContent: body.params?.name === 'execute' ? {
          status: 'waiting_for_interaction', executionId: 'exec_fixture', interaction: {
            kind: 'form', message: 'Allow Computer Use to use "Finder"?',
            address: 'tools.codex_computer_use.org.localComputerUse.get_app_state', args: { app: 'Finder' },
            requestedSchema: { type: 'object', properties: {} }, meta: { connector_id: 'computer-use' },
          },
        } : { status: 'completed', result: 'Finder ready' } } }))
      })
    })
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => upstreamHttp.listen(0, '127.0.0.1', resolve))
    const address = broker.address()
    const httpAddress = upstreamHttp.address()
    if (!address || typeof address === 'string' || !httpAddress || typeof httpAddress === 'string') throw new Error('No port')
    try {
      const upstream: EffectProxyUpstream = {
        name: 'executor', command: process.execPath, args: [FIXTURE, '--executor', '--executor-ping'], envKeys: [], httpHeaders: {},
        ...(transport === 'http' ? { url: `http://127.0.0.1:${httpAddress.port}` } : {}),
      }
      const child = spawn(process.execPath, [TSX, PROXY,
        '--broker-url', `http://127.0.0.1:${address.port}`, '--capability-env', 'MANOR_EFFECT_TEST',
        '--upstream', Buffer.from(JSON.stringify(upstream)).toString('base64url'),
      ], { env: { ...process.env, MANOR_EFFECT_TEST: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child)
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        if (line.includes('fixture_ping')) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'fixture_ping', result: {} })}\n`)
      })
      const messages = lines[Symbol.asyncIterator]()
      const call = async (id: number, method: string, params: unknown) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        return nextJson(messages, id)
      }
      await call(1, 'initialize', { protocolVersion: '2025-06-18' })
      const origin = { code: 'return await tools.codex_computer_use.org.localComputerUse.get_app_state({app:"Finder"})' }
      for (let id = 4; id <= 7; id += 1) {
        expect(await call(id, 'tools/call', { name: 'execute', arguments: origin })).toMatchObject({
          id, result: { structuredContent: { status: 'completed', result: 'Finder ready' } },
        })
      }
      expect(seen.map(({ tool }) => tool)).toEqual(Array.from({ length: 4 }, () => ['execute', 'resume']).flat())
      expect(seen[1]?.reviewArguments).toMatchObject({ origin, interaction: { args: { app: 'Finder' } } })
      expect(seen[1]).toHaveProperty('continuation.permit', 'fixture-permit')
      deny = true
      expect(await call(8, 'tools/call', { name: 'execute', arguments: origin })).toMatchObject({
        result: { isError: true, content: [{ text: 'Denied' }] },
      })
      child.stdin.end()
    } finally {
      await Promise.all([broker, upstreamHttp].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    }
  })

  it('gets approval before forwarding a tool call upstream', async () => {
    let approve = false
    const seen: unknown[] = []
    const broker = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { env?: unknown }
        if (body.env === true) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ env: {} }))
          return
        }
        seen.push(body)
        response.writeHead(approve ? 200 : 403, { 'content-type': 'application/json' })
        response.end(JSON.stringify(approve ? { approved: true } : { error: 'Denied for test.' }))
      })
    })
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve))
    const address = broker.address()
    if (address === null || typeof address === 'string') throw new Error('broker did not bind')

    const marker = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-effect-')), 'calls')
    const capabilityEnv = 'MANOR_EFFECT_BROKER_CAPABILITY_TEST'
    const upstream: EffectProxyUpstream = {
      name: 'composio',
      command: process.execPath,
      args: [FIXTURE],
      envKeys: ['FAKE_CALL_MARKER'],
      httpHeaders: {},
    }
    const child = spawn(process.execPath, [
      TSX,
      PROXY,
      '--broker-url', `http://127.0.0.1:${address.port}`,
      '--capability-env', capabilityEnv,
      '--upstream', Buffer.from(JSON.stringify(upstream)).toString('base64url'),
    ], {
      env: { ...process.env, [capabilityEnv]: 'capability', FAKE_CALL_MARKER: marker },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    const lines = createInterface({ input: child.stdout })
    const messages = lines[Symbol.asyncIterator]()

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' },
    })}\n`)
    await nextJson(messages, 1)

    approve = true
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        arguments: {
          tools: Array.from({ length: 51 }, () => ({
            tool_slug: 'LINEAR_CREATE_ISSUE',
            arguments: { title: 'private' },
          })),
        },
      },
    })}\n`)
    expect(await nextJson(messages, 2)).toMatchObject({ result: { isError: true } })
    expect(existsSync(marker)).toBe(false)
    expect(seen).toEqual([])

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        arguments: { tools: [{ arguments: { title: 'private' } }] },
      },
    })}\n`)
    expect(await nextJson(messages, 3)).toMatchObject({ result: { isError: true } })
    expect(existsSync(marker)).toBe(false)
    expect(seen).toEqual([])

    approve = false
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        arguments: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { body: 'private' } }] },
      },
    })}\n`)
    const denied = await nextJson(messages, 4)
    expect(denied).toMatchObject({ result: { isError: true } })
    expect(existsSync(marker)).toBe(false)

    approve = true
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        arguments: { tools: [{ tool_slug: 'LINEAR_CREATE_ISSUE', arguments: { title: 'private' } }] },
      },
    })}\n`)
    expect(await nextJson(messages, 5)).toMatchObject({
      result: { content: [{ text: 'called:COMPOSIO_MULTI_EXECUTE_TOOL' }] },
    })
    expect(readFileSync(marker, 'utf8')).toBe('COMPOSIO_MULTI_EXECUTE_TOOL\n')
    expect(seen).toEqual([
      {
        tool: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        arguments: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] },
        reviewArguments: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { body: 'private' } }] },
      },
      {
        tool: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        arguments: { tools: [{ tool_slug: 'LINEAR_CREATE_ISSUE' }] },
        reviewArguments: { tools: [{ tool_slug: 'LINEAR_CREATE_ISSUE', arguments: { title: 'private' } }] },
      },
    ])

    child.stdin.end()
    await new Promise<void>((resolve) => broker.close(() => resolve()))
  })

  it('shows and forwards only the computer allowlist', async () => {
    const seen: string[] = []
    const seenArguments: unknown[] = []
    const broker = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { env?: boolean; tool: string; arguments?: unknown }
        if (body.env !== true) { seen.push(body.tool); seenArguments.push(body.arguments) }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body.env === true ? { env: {} } : { approved: true }))
      })
    })
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve))
    const address = broker.address()
    if (address === null || typeof address === 'string') throw new Error('broker did not bind')
    const marker = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-computer-')), 'calls')
    try {
      const upstream: EffectProxyUpstream = {
        name: 'computer', command: process.execPath, args: [FIXTURE, '--cua'], envKeys: ['FAKE_CALL_MARKER'],
        httpHeaders: {}, allowTools: ['get_window_state', 'click'],
      }
      const child = spawn(process.execPath, [TSX, PROXY,
        '--broker-url', `http://127.0.0.1:${address.port}`, '--capability-env', 'MANOR_EFFECT_TEST',
        '--upstream', Buffer.from(JSON.stringify(upstream)).toString('base64url'),
      ], { env: { ...process.env, MANOR_EFFECT_TEST: 'test', FAKE_CALL_MARKER: marker }, stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child)
      const messages = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
      const call = async (id: number, method: string, params: unknown) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        return nextJson(messages, id)
      }
      await call(1, 'initialize', { protocolVersion: '2025-06-18' })
      const listed = await call(2, 'tools/list', {}) as { result: { tools: { name: string }[] } }
      expect(listed.result.tools.map(({ name }) => name)).toEqual(['get_window_state', 'click'])
      expect(await call(3, 'tools/call', { name: 'bring_to_front', arguments: {} })).toMatchObject({
        result: { isError: true, content: [{ text: 'computer.bring_to_front is not available in Manor.' }] },
      })
      expect(await call(4, 'tools/call', { name: 'click', arguments: { pid: 1 } })).toMatchObject({
        result: { content: [{ text: 'called:click' }] },
      })
      expect(seen).toEqual(['click'])
      // The background check on the server needs the real arguments, not the review copy.
      expect(seenArguments).toEqual([{ pid: 1 }])
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['click'])
      child.stdin.end()
    } finally {
      await new Promise<void>((resolve) => broker.close(() => resolve()))
    }
  })

  it('answers the Codex engine\'s app question only inside an admitted call', async () => {
    const seen: string[] = []
    const broker = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { env?: boolean; tool: string }
        if (body.env !== true) seen.push(body.tool)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body.env === true ? { env: {} } : { approved: true }))
      })
    })
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve))
    const address = broker.address()
    if (address === null || typeof address === 'string') throw new Error('broker did not bind')
    const marker = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-codex-computer-')), 'calls')
    try {
      const upstream: EffectProxyUpstream = {
        name: 'codex-computer', command: process.execPath, args: [FIXTURE, '--codex-computer'],
        envKeys: ['FAKE_CALL_MARKER'], httpHeaders: {}, allowTools: ['js', 'js_reset'],
      }
      const child = spawn(process.execPath, [TSX, PROXY,
        '--broker-url', `http://127.0.0.1:${address.port}`, '--capability-env', 'MANOR_EFFECT_TEST',
        '--upstream', Buffer.from(JSON.stringify(upstream)).toString('base64url'),
      ], { env: { ...process.env, MANOR_EFFECT_TEST: 'test', FAKE_CALL_MARKER: marker }, stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child)
      const messages = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
      const call = async (id: number, method: string, params: unknown) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        return nextJson(messages, id)
      }
      await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const listed = await call(2, 'tools/list', {}) as { result: { tools: { name: string }[] } }
      expect(listed.result.tools.map(({ name }) => name)).toEqual(['js', 'js_reset'])
      // The fixture reserves id 3 for its profile probe.
      expect(await call(5, 'tools/call', { name: 'js', arguments: { code: 'await cua.getApp("Calculator")' } }))
        .toMatchObject({ result: { content: [{ text: 'js:accept' }] } })
      expect(await call(6, 'tools/call', { name: 'js', arguments: { code: 'audio' } }))
        .toMatchObject({ result: { content: [{ text: 'js:decline' }] } })
      expect(seen).toEqual(['js', 'js'])
      // The CLI never sees the question, and one asked outside any call is declined.
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual([
        'elicitation:{"form":{}}', 'unsolicited:decline', 'js', 'js',
      ])
      child.stdin.end()
    } finally {
      await new Promise<void>((resolve) => broker.close(() => resolve()))
    }
  })

  it('does not pass HOME or sibling secrets to the upstream stdio server', async () => {
    const dump = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-effect-')), 'env')
    const capabilities = new EffectCapabilities()
    capabilities.issue(
      { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: true },
      {
        id: 'mail',
        name: 'mail',
        command: process.execPath,
        args: [FIXTURE],
        envKeys: ['FAKE_ENV_DUMP'],
        description: '',
        writes: true,
        effectPolicy: 'confirm_writes',
        tools: [],
        readOnlyTools: [],
        schemaChars: 0,
      },
      'capability',
      { FAKE_ENV_DUMP: dump },
    )
    const envFetches: Record<string, string>[] = []
    const broker = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { env?: unknown }
        if (body.env === true) {
          const header = request.headers['x-manor-effect-capability']
          const token = Array.isArray(header) ? header[0] : header
          const env = capabilities.takeEnv(token)
          envFetches.push(env)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ env }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ approved: true }))
      })
    })
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve))
    const address = broker.address()
    if (address === null || typeof address === 'string') throw new Error('broker did not bind')

    const capabilityEnv = 'MANOR_EFFECT_BROKER_CAPABILITY_TEST'
    const upstream: EffectProxyUpstream = {
      name: 'mail',
      command: process.execPath,
      args: [FIXTURE],
      envKeys: ['FAKE_ENV_DUMP'],
      httpHeaders: {},
    }
    const child = spawn(process.execPath, [
      TSX,
      PROXY,
      '--broker-url', `http://127.0.0.1:${address.port}`,
      '--capability-env', capabilityEnv,
      '--upstream', Buffer.from(JSON.stringify(upstream)).toString('base64url'),
    ], {
      env: {
        ...process.env,
        [capabilityEnv]: 'capability',
        HOME: '/should-not-reach-upstream',
        SIBLING_SECRET: 'other-mailbox',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    const lines = createInterface({ input: child.stdout })
    const messages = lines[Symbol.asyncIterator]()

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' },
    })}\n`)
    await nextJson(messages, 1)

    const dumped = JSON.parse(readFileSync(dump, 'utf8')) as {
      HOME: string | null
      SIBLING_SECRET: string | null
    }
    expect(dumped.HOME).toBeNull()
    expect(dumped.SIBLING_SECRET).toBeNull()
    expect(envFetches).toEqual([{ FAKE_ENV_DUMP: dump }])
    expect(capabilities.takeEnv('capability')).toEqual({})

    child.stdin.end()
    await new Promise<void>((resolve) => broker.close(() => resolve()))
  })
})

async function nextJson(
  lines: AsyncIterator<string>,
  id: number,
): Promise<Record<string, unknown>> {
  while (true) {
    const next = await lines.next()
    if (next.done) throw new Error(`proxy closed before response ${id}`)
    try {
      const parsed = JSON.parse(next.value) as Record<string, unknown>
      if (parsed.id === id) return parsed
    } catch {
      // Upstream banners are legal on stdout and are forwarded unchanged.
    }
  }
}
