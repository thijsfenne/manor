import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoRulesSchema, MODELS, effortsFor } from '@manor/contracts'
import { createTypesafeRuntimeSelector } from '../src/drivers/typesafeRuntime.js'
import { sage as mockSage } from './helpers.js'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}))

const sage = { ...mockSage, driver: 'grok' as const }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const answer = (choice: string, confidence = 0.9) =>
  Response.json({ answers: { route: { type: 'choice', choice, confidence } } })

describe('TypeSafe runtime selection', () => {
  // Read rather than copied: the settings dialog edits this file, so a table of its
  // values here would fail the suite every time a rule is changed on purpose.
  const shipped = Object.entries(AutoRulesSchema.parse(JSON.parse(
    readFileSync(new URL('../auto-runtime.json', import.meta.url), 'utf8'),
  )))

  it.each(shipped)('maps %s to the configured runtime independently of the current provider', async (choice, rule) => {
    const { description: _description, ...runtime } = rule
    const request = vi.fn<typeof fetch>().mockImplementation(async () => answer(choice))
    vi.stubGlobal('fetch', request)
    const select = createTypesafeRuntimeSelector('test-key')
    for (const current of ['claude', 'codex', 'grok', 'cursor'] as const) {
      await expect(select({ ...sage, driver: current }, 'Task')).resolves.toEqual({
        runtime, category: choice, confidence: 0.9,
      })
    }
    expect(MODELS[runtime.driver].some((option) => option.value === runtime.model)).toBe(true)
    expect(effortsFor(runtime.driver, runtime.model).some((option) => option.value === runtime.effort)).toBe(true)
  })

  it('sends category descriptions and task context, without persona memory, tools or model names', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(answer('judgment-prose'))
    vi.stubGlobal('fetch', request)
    const agent = { ...sage, memoryScope: true, character: 'private character' }
    await createTypesafeRuntimeSelector('test-key')(agent, 'Review the architecture')
    const payload = JSON.parse(String(request.mock.calls[0]?.[1]?.body))
    expect(payload.state).toEqual({
      task: 'Review the architecture',
      agent: { name: agent.name, description: agent.description || agent.role },
    })
    expect(payload.questions.route.instructions).toContain(
      'A greeting, acknowledgement or other small message that a category describes is that category, not defer.',
    )
    expect(payload.questions.route.criteria).toMatchObject({
      routine: expect.stringContaining('Greetings'),
      'judgment-prose': expect.stringContaining('Advice'),
      defer: expect.stringContaining('missing the actual request'),
    })
    expect(payload.questions.route.criteria.defer).not.toMatch(/identifiable assignment/i)
    expect(JSON.stringify(payload)).not.toContain('private character')
    expect(JSON.stringify(payload)).not.toContain('claude-fable')
  })

  it('rereads edited categories and settings for the next selection, including direct Grok', async () => {
    const read = vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      custom: { description: 'An explicit task category', driver: 'grok', model: 'grok-4.6', effort: 'xhigh' },
    }))
    const request = vi.fn<typeof fetch>().mockImplementation(async () => answer('custom'))
    vi.stubGlobal('fetch', request)
    const select = createTypesafeRuntimeSelector('test-key')
    await expect(select(sage, 'Task')).resolves.toEqual({ runtime: { driver: 'grok', model: 'grok-4.6', effort: 'xhigh' }, category: 'custom', confidence: 0.9 })
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).questions.route.criteria.custom).toBe('An explicit task category')
    read.mockResolvedValue(JSON.stringify({
      custom: { description: 'An edited category', driver: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    }))
    await expect(select(sage, 'Task')).resolves.toEqual({ runtime: { driver: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, category: 'custom', confidence: 0.9 })
  })

  it('tells the classifier that a chief of staff turn is routing, and nobody else', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(answer('judgment-prose'))
    vi.stubGlobal('fetch', request)
    const select = createTypesafeRuntimeSelector('test-key')
    await select({ ...sage, isCos: true }, 'Build the importer')
    await select(sage, 'Build the importer')
    const instructionsFor = (call: number) =>
      String(JSON.parse(String(request.mock.calls[call]?.[1]?.body)).questions.route.instructions)
    expect(instructionsFor(0)).toContain('chief of staff')
    expect(instructionsFor(0)).toContain('classify the routing turn itself, not the work being handed out')
    // The categories stay whatever the file holds, so a large ask can still route heavy.
    expect(instructionsFor(0)).not.toMatch(/routine|judgment-prose/)
    expect(instructionsFor(1)).not.toContain('chief of staff')
  })

  it.each([
    ['broken JSON', '{'],
    ['empty rules', '{}'],
    ['reserved category', JSON.stringify({ defer: { description: 'Task', driver: 'codex', model: 'gpt-6-luna', effort: 'low' } })],
    ['unknown provider', JSON.stringify({ task: { description: 'Task', driver: 'invented', model: 'gpt-6-luna', effort: 'low' } })],
    ['wrong provider model', JSON.stringify({ task: { description: 'Task', driver: 'claude', model: 'gpt-6-luna', effort: 'low' } })],
    ['unsupported effort', JSON.stringify({ task: { description: 'Task', driver: 'grok', model: 'grok-4.5', effort: 'xhigh' } })],
    ['unsupported speed', JSON.stringify({ task: { description: 'Task', driver: 'grok', model: 'grok-4.6', effort: 'high', speed: 'fast' } })],
    ['mock destination', JSON.stringify({ task: { description: 'Task', driver: 'mock', model: 'mock', effort: 'low' } })],
  ])('keeps the fallback without paying for a request when rules contain %s', async (_name, rules) => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(rules)
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(createTypesafeRuntimeSelector('test-key')(sage, 'Task')).resolves.toEqual({ reason: 'invalid_rules' })
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the fallback when the rules file cannot be read', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('missing'))
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(createTypesafeRuntimeSelector('test-key')(sage, 'Task')).resolves.toEqual({ reason: 'invalid_rules' })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['routine', 0.49, { reason: 'low_confidence', confidence: 0.49 }],
    ['defer', 0.9, { reason: 'defer', confidence: 0.9 }],
    ['private provider text', 0.9, { reason: 'unknown_choice' }],
  ] as const)('keeps the fallback on %s at confidence %s', async (choice, confidence, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(choice, confidence)))
    await expect(createTypesafeRuntimeSelector('test-key')(sage, 'Task')).resolves.toEqual(expected)
  })

  it('accepts a pick at 0.5, below the 0.7 the other TypeSafe routers keep', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer('routine', 0.5)))
    await expect(createTypesafeRuntimeSelector('test-key')(sage, 'Task')).resolves.toMatchObject({ category: 'routine', confidence: 0.5 })
  })

  it('keeps the reviewer on its provider and the engineer on its model, and lets other agents switch', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      fix: { description: 'Fix a bug', driver: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      hardest: { description: 'Hard work', driver: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
      explore: { description: 'Explore code', driver: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' },
      routine: { description: 'Small edit', driver: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    }))
    const argus = { ...sage, id: 'argus', name: 'Argus', driver: 'codex' as const }
    const wren = { ...sage, id: 'wren', name: 'Wren', driver: 'claude' as const, model: 'claude-opus-5-5' }
    const pick = (category: string) => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => answer(category)))
    const select = createTypesafeRuntimeSelector('test-key')
    pick('fix')
    await expect(select(argus, 'Review this bug fix')).resolves.toEqual({ reason: 'session_pair', category: 'fix', confidence: 0.9 })
    await expect(select({ ...sage, driver: 'codex' }, 'Fix this bug')).resolves.toMatchObject({ runtime: { driver: 'claude' } })
    pick('explore')
    await expect(select(argus, 'Trace this')).resolves.toMatchObject({ runtime: { driver: 'codex', effort: 'xhigh' } })
    await expect(select(wren, 'Trace this')).resolves.toEqual({ reason: 'session_pair', category: 'explore', confidence: 0.9 })
    await expect(select({ ...sage, id: 'ellis', name: 'Ellis' }, 'Trace this')).resolves.toMatchObject({ runtime: { driver: 'codex' } })
    pick('routine')
    await expect(select(wren, 'Rename a label')).resolves.toEqual({ reason: 'session_pair', category: 'routine', confidence: 0.9 })
    pick('hardest')
    await expect(select(wren, 'Rebuild the router')).resolves.toMatchObject({ runtime: { model: 'claude-opus-5-5', effort: 'xhigh' } })
  })

  it('makes no paid request without a key or for a mock runtime', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(createTypesafeRuntimeSelector(undefined)(sage, 'Task')).resolves.toEqual({ reason: 'missing_key' })
    await expect(createTypesafeRuntimeSelector('test-key')({ ...sage, driver: 'mock' }, 'Task')).resolves.toEqual({ reason: 'mock_runtime' })
    expect(request).not.toHaveBeenCalled()
  })

  it('distinguishes HTTP, transport and invalid responses without returning private provider details', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('private provider text', { status: 429 }))
      .mockRejectedValueOnce(new Error('private provider text test-key'))
      .mockResolvedValueOnce(new Response('private provider text'))
      .mockResolvedValueOnce(Response.json({ answers: {} }))
    vi.stubGlobal('fetch', request)
    const select = createTypesafeRuntimeSelector('test-key')
    for (const expected of [
      { reason: 'http_error', httpStatus: 429 },
      { reason: 'api_error' },
      { reason: 'invalid_response' },
      { reason: 'invalid_response' },
    ]) {
      await expect(select(sage, 'private task')).resolves.toEqual(expected)
    }
    expect(request).toHaveBeenCalledTimes(4)
  })

  it.each(['request', 'body'])('reports timeout for a stalled %s even when abort rejects the request', async (stage) => {
    vi.useFakeTimers()
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      routine: { description: 'Routine task', driver: 'codex', model: 'gpt-6-luna', effort: 'high' },
    }))
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const pending = new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('private abort error')), { once: true })
      })
      if (stage === 'request') return pending
      const response = new Response()
      vi.spyOn(response, 'json').mockReturnValue(pending)
      return response
    })
    vi.stubGlobal('fetch', request)
    const selected = createTypesafeRuntimeSelector('test-key')(sage, 'Task')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(selected).resolves.toEqual({ reason: 'timeout' })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
