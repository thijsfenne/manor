import type { AttachedMcpServer } from '@manor/contracts'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildMcpArgs } from '../src/drivers/claudeDriver.js'
import { buildCodexMcpArgs } from '../src/drivers/codexDriver.js'
import { buildCursorMcpConfig } from '../src/drivers/cursorDriver.js'
import { askModeFor, interactionMcpAttachment } from '../src/mcp/interactionAttachment.js'
import { interactionMcpServer } from '../src/mcp/interactionServer.js'
import { toolServerRpc, type JsonRecord } from '../src/mcp/stdio.js'

/** Serves the attachment's flags through the dispatcher the HTTP host mounts, under its own capability. */
function connect(attachment: AttachedMcpServer) {
  const rpc = toolServerRpc(interactionMcpServer(attachment.server.args))
  const capability = Object.values(attachment.runtimeEnv ?? {})[0] ?? ''
  return (message: JsonRecord) => rpc({ jsonrpc: '2.0', ...message }, capability)
}

describe('the built-in Manor interaction MCP attachment', () => {
  it('keeps the turn capability out of every provider argv', () => {
    const attachment = interactionMcpAttachment(
      'http://127.0.0.1:8787/internal/user-input',
      'secret-turn-capability',
    )

    expect(attachment.server.tools).toEqual(['ask_user', 'prepare_outbound_draft'])
    expect(attachment.server.description).not.toContain('consult')
    expect(attachment.server.description).not.toContain('message_agent')
    expect(attachment.server.args).toEqual([
      '--broker-url', 'http://127.0.0.1:8787/internal/user-input',
      '--draft-url', 'http://127.0.0.1:8787/internal/outbound-draft',
      '--relay-url', 'http://127.0.0.1:8787/internal/agent-relay',
      '--subagent-url', 'http://127.0.0.1:8787/internal/subagent',
      '--deliver-url', 'http://127.0.0.1:8787/internal/deliver-file',
      '--goal-url', 'http://127.0.0.1:8787/internal/goal-claims',
      '--project-url', 'http://127.0.0.1:8787/internal/project-thread',
      '--secret-url', 'http://127.0.0.1:8787/internal/secret-request',
      '--tool', 'ask_user',
      '--tool', 'prepare_outbound_draft',
    ])
    expect(attachment.disabledTools).toEqual([])
    expect(attachment.runtimeEnv).toEqual({ MANOR_USER_INPUT_CAPABILITY: 'secret-turn-capability' })
    expect(buildMcpArgs([attachment]).join(' ')).not.toContain('secret-turn-capability')
    expect(buildCodexMcpArgs([attachment]).join(' ')).not.toContain('secret-turn-capability')
    expect(buildCursorMcpConfig([attachment])).not.toContain('secret-turn-capability')
  })

  it('keeps draft preparation but removes blocking questions from unattended routines', () => {
    const attachment = interactionMcpAttachment(
      'http://127.0.0.1:8787/internal/user-input',
      'routine-capability',
      { allowAsk: false },
    )

    expect(attachment.server.tools).toEqual(['prepare_outbound_draft'])
    expect(attachment.disabledTools).toEqual([])
    expect(attachment.server.args.slice(-2)).toEqual(['--tool', 'prepare_outbound_draft'])
  })

  // Codex cells yield after ~30 s and Cursor's MCP client times out at 60 s.
  it('posts questions on Codex and Cursor and holds them on Claude and Grok', () => {
    expect(['claude', 'codex', 'grok', 'cursor'].map(askModeFor)).toEqual(['blocking', 'deferred', 'blocking', 'deferred'])
    const url = 'http://127.0.0.1:8787/internal/user-input'
    expect(interactionMcpAttachment(url, 'c', { askMode: 'deferred' }).server.args).toContain('--ask-mode')
    expect(interactionMcpAttachment(url, 'c', { askMode: 'blocking' }).server.args).not.toContain('--ask-mode')
    expect(interactionMcpAttachment(url, 'c', { askMode: 'deferred', allowAsk: false }).server.args).not.toContain('--ask-mode')
  })

  it('advertises and accepts only the tools granted to its process', async () => {
    const attachment = interactionMcpAttachment(
      'http://127.0.0.1:1/internal/user-input',
      'routine-capability',
      { allowAsk: false },
    )
    const send = connect(attachment)

    expect(await send({ id: 2, method: 'tools/list' })).toMatchObject({
      result: { tools: [{ name: 'prepare_outbound_draft' }] },
    })
    expect(await send({ id: 3, method: 'tools/call', params: { name: 'ask_user', arguments: { questions: [] } } })).toMatchObject({
      result: { isError: true, content: [{ text: 'Unknown Manor tool ask_user.' }] },
    })
  })

  it('enables agent messaging only when the turn explicitly grants it', () => {
    const attachment = interactionMcpAttachment(
      'http://127.0.0.1:8787/internal/user-input',
      'relay-capability',
      { allowAsk: false, allowDraft: false, allowRelay: true },
    )

    expect(attachment.server.tools).toEqual(['message_agent'])
    expect(attachment.server.description).toBe('Consult an allowed agent in this workspace with message_agent.')
    expect(attachment.disabledTools).toEqual([])
    expect(attachment.server.args.slice(-4)).toEqual([
      '--relay-mode', 'async',
      '--tool', 'message_agent',
    ])
  })

  it('withholds only delegate_task with an empty catalog, and lets Codex hold the waits', async () => {
    const none = interactionMcpAttachment('http://127.0.0.1:1/internal/user-input', 'c', { subagents: { models: [], maxConcurrent: 3 } })
    // Children started before Settings narrowed stay collectable and cancellable.
    expect(none.server.tools).toEqual(['ask_user', 'prepare_outbound_draft', 'task_result', 'task_cancel', 'subagent_capabilities'])
    expect(buildCodexMcpArgs([none]).join(' ')).not.toContain('delegate_task')
    expect(interactionMcpAttachment('http://127.0.0.1:1/internal/user-input', 'c').server.tools).not.toContain('task_result')

    const bodies: unknown[] = []
    const broker = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const parsed = JSON.parse(body)
      bodies.push({ url: request.url, capability: request.headers['x-manor-user-input-capability'], body: parsed })
      const refused = parsed.model === 'claude-opus-5-5'
      response.writeHead(refused ? 400 : 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(refused
        ? { error: 'claude-opus-5-5 is not allowed for subagents in Settings.' }
        : { report: { taskId: 'chat_9', status: 'done', result: 'Four.' } }))
    })
    broker.listen(0, '127.0.0.1')
    await once(broker, 'listening')
    const address = broker.address()
    if (address === null || typeof address === 'string') throw new Error('the broker should have a TCP address')
    const catalog = { models: [{ model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'codex', efforts: ['low', 'high'] }], maxConcurrent: 3 }
    const attachment = interactionMcpAttachment(
      `http://127.0.0.1:${address.port}/internal/user-input`, 'subagent-capability',
      { allowAsk: false, allowDraft: false, subagents: catalog },
    )
    expect(attachment.server.tools).toEqual(['delegate_task', 'task_result', 'task_cancel', 'subagent_capabilities'])
    expect(attachment.server.description).toContain('delegate_task')
    const codexArgs = buildCodexMcpArgs([attachment]).join(' ')
    expect(codexArgs).toContain('tool_timeout_sec=300')
    expect(codexArgs).toContain('delegate_task={approval_mode="approve"}')

    const send = connect(attachment)
    try {
      const listed = await send({ id: 1, method: 'tools/list' })
      expect(listed).toMatchObject({ result: { tools: [
        { name: 'delegate_task', inputSchema: { properties: { model: { enum: ['gpt-6.1-sol'] }, effort: { enum: ['low', 'high'] } } } },
        { name: 'task_result' }, { name: 'task_cancel' }, { name: 'subagent_capabilities' },
      ] } })
      expect(await send({ id: 2, method: 'tools/call', params: { name: 'delegate_task', arguments: { task: 'Add 2 and 2.', model: 'gpt-6.1-sol', effort: 'high' } } })).toMatchObject({ result: { content: [{ text: JSON.stringify({ taskId: 'chat_9', status: 'done', result: 'Four.' }) }] } })
      expect(await send({ id: 3, method: 'tools/call', params: { name: 'delegate_task', arguments: { task: 'x', model: 'claude-opus-5-5', effort: 'high' } } })).toMatchObject({ result: { isError: true, content: [{ text: 'claude-opus-5-5 is not allowed for subagents in Settings.' }] } })
      expect(bodies[0]).toEqual({
        url: '/internal/subagent', capability: 'subagent-capability',
        body: { action: 'delegate_task', task: 'Add 2 and 2.', model: 'gpt-6.1-sol', effort: 'high' },
      })
    } finally {
      broker.close()
      await once(broker, 'close')
    }
  })

  it('offers goal_reached and review_passed only to granted turns; goal claims go through the broker', async () => {
    expect(interactionMcpAttachment('http://127.0.0.1:1/internal/user-input', 'c').server.tools).not.toContain('goal_reached')
    expect(interactionMcpAttachment('http://127.0.0.1:1/internal/user-input', 'c').server.tools).not.toContain('review_passed')
    const bodies: unknown[] = []
    const broker = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const parsed = JSON.parse(body)
      bodies.push({ url: request.url, capability: request.headers['x-manor-user-input-capability'], body: parsed })
      const refused = parsed.claims === undefined
      response.writeHead(refused ? 422 : 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(refused ? { error: 'goal_reached needs claims.' } : { ok: true }))
    })
    broker.listen(0, '127.0.0.1')
    await once(broker, 'listening')
    const address = broker.address()
    if (address === null || typeof address === 'string') throw new Error('the broker should have a TCP address')
    const attachment = interactionMcpAttachment(
      `http://127.0.0.1:${address.port}/internal/user-input`, 'goal-capability',
      { allowAsk: false, allowDraft: false, allowGoal: true, allowReview: true },
    )
    expect(attachment.server.tools).toEqual(['goal_reached', 'review_passed'])
    const send = connect(attachment)
    try {
      expect(await send({ id: 1, method: 'tools/list' })).toMatchObject({ result: { tools: [{ name: 'goal_reached' }, { name: 'review_passed' }] } })
      expect(await send({ id: 2, method: 'tools/call', params: { name: 'goal_reached', arguments: {} } })).toMatchObject({ result: { isError: true, content: [{ text: 'goal_reached needs claims.' }] } })
      const claims = [{ claim: 'Tests pass.', level: 'ran', ref: 'pnpm test: 3 passed' }]
      const report = { result: 'Export is available.', limitations: 'Attachments remain links.' }
      const reply = await send({ id: 4, method: 'tools/call', params: { name: 'goal_reached', arguments: { claims, report } } })
      expect(reply).not.toHaveProperty('result.isError')
      expect(reply).toMatchObject({ result: { content: [{ text: expect.stringContaining('Recorded.') }] } })
      expect(bodies).toEqual([
        { url: '/internal/goal-claims', capability: 'goal-capability', body: {} },
        { url: '/internal/goal-claims', capability: 'goal-capability', body: { claims, report } },
      ])
      const review = await send({ id: 3, method: 'tools/call', params: { name: 'review_passed', arguments: {} } })
      expect(review).not.toHaveProperty('result.isError')
      expect(review).toMatchObject({ result: { content: [{ text: expect.stringContaining('Recorded.') }] } })
    } finally {
      broker.close()
      await once(broker, 'close')
    }
  })

  it('offers deliver_file only when granted and relays the server refusal to the persona', async () => {
    expect(interactionMcpAttachment('http://127.0.0.1:1/internal/user-input', 'c').server.tools).not.toContain('deliver_file')
    const bodies: unknown[] = []
    const broker = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      bodies.push({ url: request.url, capability: request.headers['x-manor-user-input-capability'], body: JSON.parse(body) })
      response.writeHead(422, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: '/tmp/gone.xlsx does not exist.' }))
    })
    broker.listen(0, '127.0.0.1')
    await once(broker, 'listening')
    const address = broker.address()
    if (address === null || typeof address === 'string') throw new Error('the broker should have a TCP address')
    const attachment = interactionMcpAttachment(
      `http://127.0.0.1:${address.port}/internal/user-input`,
      'deliver-capability',
      { allowAsk: false, allowDraft: false, allowDeliver: true },
    )
    expect(attachment.server.tools).toEqual(['deliver_file'])
    const send = connect(attachment)
    try {
      expect(await send({ id: 1, method: 'tools/call', params: { name: 'deliver_file', arguments: { path: '/tmp/gone.xlsx', name: 'Q3.xlsx' } } })).toMatchObject({
        result: { isError: true, content: [{ text: '/tmp/gone.xlsx does not exist.' }] },
      })
      expect(await send({ id: 2, method: 'tools/call', params: { name: 'deliver_file', arguments: { path: '/tmp/screen.html', viewport: 'tablet' } } })).toMatchObject({ result: { isError: true } })
      await send({ id: 3, method: 'tools/call', params: { name: 'deliver_file', arguments: { path: '/tmp/screen.html', viewport: 'phone' } } })
      expect(bodies).toEqual([
        { url: '/internal/deliver-file', capability: 'deliver-capability', body: { path: '/tmp/gone.xlsx', name: 'Q3.xlsx' } },
        { url: '/internal/deliver-file', capability: 'deliver-capability', body: { path: '/tmp/screen.html', viewport: 'phone' } },
      ])
    } finally {
      broker.close()
      await once(broker, 'close')
    }
  })

  it('dispatches concurrent agent messages before either broker response completes', async () => {
    const received: string[] = []
    let noteBothReceived: (() => void) | undefined
    let releaseResponses: (() => void) | undefined
    const bothReceived = new Promise<void>((resolve) => { noteBothReceived = resolve })
    const responsesReleased = new Promise<void>((resolve) => { releaseResponses = resolve })
    const broker = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const payload = JSON.parse(body) as { to: string }
      received.push(payload.to)
      if (received.length === 2) noteBothReceived?.()
      await responsesReleased
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ reply: `Messaged ${payload.to}.` }))
    })
    broker.listen(0, '127.0.0.1')
    await once(broker, 'listening')
    const address = broker.address()
    if (address === null || typeof address === 'string') throw new Error('the relay broker should have a TCP address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const attachment = interactionMcpAttachment(
      `${baseUrl}/internal/user-input`,
      'relay-capability',
      {
        relayBrokerUrl: `${baseUrl}/internal/agent-relay`,
        allowAsk: false,
        allowDraft: false,
        allowRelay: true,
      },
    )
    const send = connect(attachment)

    try {
      const first = send({ id: 2, method: 'tools/call', params: { name: 'message_agent', arguments: { to: 'Sage', text: 'First' } } })
      const second = send({ id: 3, method: 'tools/call', params: { name: 'message_agent', arguments: { to: 'Smith', text: 'Second' } } })

      await Promise.race([
        bothReceived,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('the second relay stayed serialized')), 5_000)),
      ])
      expect(received).toEqual(['Sage', 'Smith'])
      releaseResponses?.()

      expect(await first).toMatchObject({ result: { content: [{ text: 'Messaged Sage.' }] } })
      expect(await second).toMatchObject({ result: { content: [{ text: 'Messaged Smith.' }] } })
    } finally {
      releaseResponses?.()
      broker.close()
      await once(broker, 'close')
    }
  })
})
