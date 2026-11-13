import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { RuntimeEvent, TurnInput } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeDiagnostics, handleDiagnostics } from '../src/runtimeDiagnostics.js'
import { AsyncQueue } from '../src/asyncQueue.js'
import { sage } from './helpers.js'

const input: TurnInput = { agent: { ...sage, character: 'PRIVATE PERSONA' }, cwd: '/private/path', threadId: 'private-chat', repoPaths: [],
  catchUp: [{ id: 'private', ts: 1, type: 'user_message', text: 'PRIVATE PROMPT', mentions: [] }], isFullCatchUp: true }

describe('runtime diagnostics', () => {
  it('measures milestones without consuming, copying or exposing runtime content', async () => {
    const diagnostics = new RuntimeDiagnostics()
    const span = diagnostics.start(input, Date.now() - 5)
    span.stage('processStarted'); span.stage('processInitialized'); span.stage('threadReady')
    const queue = new AsyncQueue<RuntimeEvent>()
    const events: RuntimeEvent[] = [{ type: 'delta', messageId: 'm', text: 'PRIVATE ANSWER' }, { type: 'result', text: 'PRIVATE ANSWER', reportedModel: 'gpt-5.6-luna', observedSpeed: 'fast' }]
    events.forEach((event) => queue.push(event)); queue.close()
    const handle = span.observe({ events: queue, stop() {}, steer: async () => 'accepted' })
    const collected = []
    for await (const event of handle.events) collected.push(event)
    expect(collected).toEqual(events)
    const report = await diagnostics.report({}, [], false)
    expect(report.turns[0]).toMatchObject({ outcome: 'completed', reportedModel: 'gpt-5.6-luna', observedSpeed: 'fast', stagesMs: {
      inputPrepared: expect.any(Number), firstEvent: expect.any(Number), firstVisibleText: expect.any(Number), finished: expect.any(Number),
    } })
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|private/)
    expect(report.browser).toEqual({ ready: false, error: 'no_desktop_host' })
  })

  it('hands each finished turn to the sink as one content-free line', async () => {
    const lines: string[] = []
    const queue = new AsyncQueue<RuntimeEvent>()
    queue.push({ type: 'result', text: 'PRIVATE ANSWER' }); queue.close()
    const handle = new RuntimeDiagnostics((line) => lines.push(line)).start({ ...input, singleSession: true }, Date.now()).observe({ events: queue, stop() {} })
    for await (const event of handle.events) void event
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ provider: sage.driver, single: true, resumed: false, outcome: 'completed', stagesMs: { finished: expect.any(Number) } })
    expect(lines[0]).not.toMatch(/PRIVATE|private/)
  })

  it('bounds reports and preserves Stop and native steering', async () => {
    const diagnostics = new RuntimeDiagnostics()
    const stop = vi.fn()
    const steer = vi.fn(async () => 'accepted' as const)
    for (let index = 0; index < 55; index += 1) diagnostics.start(input, Date.now())
    const handle = diagnostics.start(input, Date.now()).observe({ events: new AsyncQueue(), stop, steer })
    await handle.steer?.({ type: 'user_message', id: 's', ts: 1, text: 'hi', mentions: [] })
    handle.stop()
    expect(stop).toHaveBeenCalledOnce(); expect(steer).toHaveBeenCalledOnce()
    const report = await diagnostics.report({}, [], true)
    expect(report.turns).toHaveLength(50)
    expect(report.turns.at(-1)?.outcome).toBe('stopped')
  })

  it('requires the existing auth gate and never returns exception details', async () => {
    const report = vi.fn(async () => ({ ok: true }))
    const server = createServer((request, response) => void handleDiagnostics(request, response, { allow: async (token) => token === 'test-token' }, report))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/diagnostics`
      expect((await fetch(url)).status).toBe(401)
      expect(report).not.toHaveBeenCalled()
      const response = await fetch(url, { headers: { authorization: 'Bearer test-token' } })
      expect(await response.json()).toEqual({ ok: true })
      expect(response.headers.get('cache-control')).toBe('no-store')
    } finally { server.close(); await once(server, 'close') }
  })
})
