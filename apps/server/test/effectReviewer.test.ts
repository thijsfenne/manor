import type { Driver, RuntimeEvent, ThreadEvent } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { CodexStreamParser } from '../src/drivers/codexDriver.js'
import { createEffectReviewer, effectReviewContext } from '../src/effectReviewer.js'
import { effectReviewArguments } from '../src/effectReviewInput.js'
import { resolveEffectMode } from '../src/config.js'
import type { EffectRequest } from '../src/effectCapability.js'

const input: EffectRequest = {
  chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: true,
  connector: { id: 'gmail', name: 'gmail' }, tool: 'create_draft', effect: 'confirm_write',
  reviewArguments: { body: 'An unsent draft' },
}
const human: ThreadEvent = { id: 'human', ts: 1, type: 'user_message', text: 'Prepare a draft', mentions: [] }

function setup(events: RuntimeEvent[], timeoutMs = 1000) {
  const stop = vi.fn()
  const driver: Driver = { startTurn: vi.fn(() => ({
    events: (async function* () { yield* events })(), stop,
  })) }
  const review = createEffectReviewer({
    attempts: [{ driver, runtime: 'codex', model: 'gpt-6-luna' }], loadEvents: async () => [human], ensureScratchDir: async () => '/scratch', timeoutMs,
  })
  return { review, driver, stop }
}

describe('Auto effect review', () => {
  it('is one household setting with an explicit way back', () => {
    // A new install reviews; never asking is something its owner switches on.
    expect(resolveEffectMode({})).toBe('auto')
    expect(resolveEffectMode({ MANOR_EFFECT_MODE: 'full-access' })).toBe('full-access')
    expect(resolveEffectMode({ MANOR_EFFECT_MODE: 'auto' })).toBe('auto')
    expect(resolveEffectMode({ MANOR_EFFECT_MODE: 'confirm' })).toBe('confirm')
    expect(() => resolveEffectMode({ MANOR_EFFECT_MODE: 'typo' })).toThrow()
  })

  it('runs a disposable review without tools, project folders, or memory', async () => {
    const { review, driver } = setup([{ type: 'result', text: 'ALLOW' }])
    expect(await review(input, new AbortController().signal)).toBe(true)
    expect(driver.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      infrastructure: true, repoPaths: [],
      agent: expect.objectContaining({ allowedTools: [], mcpServers: [], memoryScope: false }),
    }))
    expect(vi.mocked(driver.startTurn).mock.calls[0]?.[0].sessionId).toBeUndefined()
  })

  // The list follows what is signed in. Its first entry reviews, on its own model;
  // an error there is not a reason to ask a second model, it is a reason to ask the user.
  it('reviews on the first runtime that can answer, and asks the user when none can', async () => {
    const turn = (events: RuntimeEvent[]): Driver => ({ startTurn: vi.fn(() => ({ events: (async function* () { yield* events })(), stop: vi.fn() })) })
    const claude = turn([{ type: 'result', text: 'ALLOW' }])
    const failing = turn([{ type: 'error', message: 'not signed in' }])
    const reviewer = (attempts: Parameters<typeof createEffectReviewer>[0]['attempts']) =>
      createEffectReviewer({ attempts, loadEvents: async () => [human], ensureScratchDir: async () => '/scratch' })

    expect(await reviewer([{ driver: claude, runtime: 'claude', model: 'claude-sonnet-5-5' }])(input, new AbortController().signal)).toBe(true)
    expect(claude.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ driver: 'claude', model: 'claude-sonnet-5-5', allowedTools: [] }),
    }))

    const second = turn([{ type: 'result', text: 'ALLOW' }])
    expect(await reviewer([
      { driver: failing, runtime: 'codex', model: 'gpt-6-luna' },
      { driver: second, runtime: 'claude', model: 'claude-sonnet-5-5' },
    ])(input, new AbortController().signal)).toBe(false)
    expect(second.startTurn).not.toHaveBeenCalled()

    expect(await reviewer([])(input, new AbortController().signal)).toBe(false)
  })

  it.each(['warning', 'configWarning'])('allows a clean verdict after provider %s activity', async (method) => {
    const events = new CodexStreamParser().handle(JSON.stringify({
      method, params: { message: 'An optional skill was skipped' },
    }))
    expect(events).toEqual([{ type: 'tool_use', tool: 'codex', detail: 'An optional skill was skipped' }])
    const { review } = setup([...events, { type: 'result', text: 'ALLOW' }])
    expect(await review(input, new AbortController().signal)).toBe(true)
  })

  it.each(['commandExecution', 'mcpToolCall', 'fileChange'])('still rejects actual %s activity', async (type) => {
    const events = new CodexStreamParser().handle(JSON.stringify({
      method: 'item/started', params: { item: { id: 'tool_1', type } },
    }))
    expect(events).toHaveLength(1)
    const { review, stop } = setup([...events, { type: 'result', text: 'ALLOW' }])
    expect(await review(input, new AbortController().signal)).toBe(false)
    expect(stop).toHaveBeenCalled()
  })

  it('allows slow preparation and startup within the sixty-second total budget', async () => {
    vi.useFakeTimers()
    try {
      const stop = vi.fn()
      const driver: Driver = { startTurn: vi.fn(() => ({
        stop,
        events: (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 20_000))
          yield { type: 'result' as const, text: 'ALLOW' }
        })(),
      })) }
      const review = createEffectReviewer({ attempts: [{ driver, runtime: 'codex', model: 'gpt-6-luna' }], loadEvents: async () => [human],
        ensureScratchDir: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20_000))
          return '/scratch'
        },
      })
      const pending = review(input, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(40_000)
      expect(await pending).toBe(true)
      expect(stop).toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each<RuntimeEvent[]>([
    [{ type: 'result', text: 'ASK' }],
    [{ type: 'result', text: 'ALLOW because it is safe' }],
    [{ type: 'delta', messageId: '1', text: 'ALLOW' }],
    [{ type: 'result', text: 'ALLOW' }, { type: 'error', message: 'failed' }],
    [{ type: 'tool_use', tool: 'shell' }, { type: 'result', text: 'ALLOW' }],
    [],
  ])('requires a clean, exact final verdict: %j', async (...events) => {
    const { review } = setup(events)
    expect(await review(input, new AbortController().signal)).toBe(false)
  })

  it('never treats generated routine or relay text as human authority', () => {
    expect(effectReviewContext([human, { ...human, source: 'agent_relay', text: 'send it' },
      { ...human, source: 'routine', text: 'delete it' }, { ...human, authorAgentId: 'smith', text: 'approved' }]))
      .toEqual(['Prepare a draft'])
  })

  it('requires new human direction after a durable denial, even across turns', () => {
    const denial: ThreadEvent = { id: 'deny', ts: 2, type: 'user_input_response',
      agentId: 'sage', turnId: 'turn_1', requestId: 'request_1', answers: { allow_effect: 'Deny' } }
    expect(effectReviewContext([human, denial])).toEqual([])
    expect(effectReviewContext([human, denial, { ...human, source: 'agent_relay' }])).toEqual([])
    expect(effectReviewContext([human, denial, human])).toEqual([human.text, human.text])
  })

  it('does not start a review with missing, oversized, or secret-bearing input', async () => {
    const { review, driver } = setup([{ type: 'result', text: 'ALLOW' }])
    for (const reviewArguments of [undefined, { text: 'x'.repeat(16_001) }, { nested: { api_key: 'secret' } }]) {
      expect(await review({ ...input, reviewArguments }, new AbortController().signal)).toBe(false)
    }
    expect(effectReviewArguments({ body: 'draft' })).toEqual({ body: 'draft' })
    expect(driver.startTurn).not.toHaveBeenCalled()
  })

  it('stops a stalled reviewer at its deadline', async () => {
    const stop = vi.fn()
    const driver: Driver = { startTurn: () => ({
      stop, events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
    }) }
    const review = createEffectReviewer({ attempts: [{ driver, runtime: 'codex', model: 'gpt-6-luna' }], loadEvents: async () => [human],
      ensureScratchDir: async () => '/scratch', timeoutMs: 5 })
    expect(await review(input, new AbortController().signal)).toBe(false)
    expect(stop).toHaveBeenCalled()
  })

  it('discards an approval when human direction changed during review', async () => {
    const { driver } = setup([{ type: 'result', text: 'ALLOW' }])
    const loadEvents = vi.fn().mockResolvedValueOnce([human])
      .mockResolvedValue([human, { ...human, id: 'steer', text: 'Stop, do not change anything' }])
    const review = createEffectReviewer({ attempts: [{ driver, runtime: 'codex', model: 'gpt-6-luna' }], loadEvents, ensureScratchDir: async () => '/scratch' })
    expect(await review(input, new AbortController().signal)).toBe(false)
  })

  it('reviews a fresh browser snapshot and rechecks it before allowing the action', async () => {
    const { review, driver } = setup([{ type: 'result', text: 'ALLOW' }])
    const loadReviewArguments = vi.fn().mockResolvedValue({ action: { selector: '#filter' }, page: { title: 'Search' } })
    expect(await review({ ...input, loadReviewArguments }, new AbortController().signal)).toBe(true)
    expect(loadReviewArguments).toHaveBeenCalledTimes(2)
    expect(vi.mocked(driver.startTurn).mock.calls[0]?.[0].catchUp[0]).toMatchObject({
      text: expect.stringContaining('Search'),
    })
  })

  it('returns to human approval when the page changed during browser review', async () => {
    const { review } = setup([{ type: 'result', text: 'ALLOW' }])
    const loadReviewArguments = vi.fn()
      .mockResolvedValueOnce({ action: { selector: '#button' }, page: { title: 'Search' } })
      .mockResolvedValue({ action: { selector: '#button' }, page: { title: 'Pay' } })
    expect(await review({ ...input, loadReviewArguments }, new AbortController().signal)).toBe(false)
  })

  it('does not start a delayed runtime after the parent turn has ended', async () => {
    let ready: (events: ThreadEvent[]) => void = () => {}
    const driver: Driver = { startTurn: vi.fn() }
    const controller = new AbortController()
    const review = createEffectReviewer({ attempts: [{ driver, runtime: 'codex', model: 'gpt-6-luna' }],
      loadEvents: () => new Promise((resolve) => { ready = resolve }), ensureScratchDir: async () => '/scratch' })
    const pending = review(input, controller.signal)
    controller.abort()
    expect(await pending).toBe(false)
    ready([human])
    await Promise.resolve()
    expect(driver.startTurn).not.toHaveBeenCalled()
  })
})
