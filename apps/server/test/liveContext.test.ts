import type { AgentConfig, LiveContext, RuntimeEvent, ServerMessage } from '@manor/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLiveContext, LIVE_CONTEXT_INTERVAL_MS } from '../src/liveContext.js'
import { createTurnStream } from '../src/turnStream.js'

describe('createLiveContext', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const tracker = () => {
    const sent: LiveContext[] = []
    return { sent, live: createLiveContext((context) => sent.push(context), LIVE_CONTEXT_INTERVAL_MS, Date.now) }
  }

  it('sends the first reading at once and merges a fast tool loop into one per interval', () => {
    const { sent, live } = tracker()
    live.reading(90_000, 258_000)
    live.reading(120_000)
    live.reading(150_000)
    expect(sent).toEqual([{ contextTokens: 90_000, contextWindow: 258_000, compacting: false }])
    vi.advanceTimersByTime(LIVE_CONTEXT_INTERVAL_MS)
    // Only the newest survives, and the window carries over from the earlier reading.
    expect(sent.at(-1)).toEqual({ contextTokens: 150_000, contextWindow: 258_000, compacting: false })
    expect(sent).toHaveLength(2)
    live.reading(150_000)
    vi.advanceTimersByTime(LIVE_CONTEXT_INTERVAL_MS)
    expect(sent).toHaveLength(2)
  })

  it('keeps the session’s compaction threshold through readings and a compaction', () => {
    const { sent, live } = tracker()
    live.reading(250_000, undefined, 300_000)
    live.compaction('start')
    live.compaction('end', 38_000)
    expect(sent.at(-1)).toEqual({ contextTokens: 38_000, autoCompactTokens: 300_000, compacting: false, compacted: true })
  })

  it('sends compaction edges without waiting, and the end drops the size from before', () => {
    const { sent, live } = tracker()
    live.reading(250_000)
    live.compaction('start')
    expect(sent.at(-1)).toEqual({ contextTokens: 250_000, compacting: true })
    live.compaction('end', 41_000)
    expect(sent.at(-1)).toEqual({ contextTokens: 41_000, compacting: false, compacted: true })
    live.compaction('start')
    live.compaction('end')
    expect(sent.at(-1)).toEqual({ compacting: false, compacted: true })
  })

  it('keeps the size through a failed compaction and settles one the stream never closed', () => {
    const { sent, live } = tracker()
    live.reading(200_000)
    live.compaction('start')
    live.compaction('failed')
    expect(sent.at(-1)).toEqual({ contextTokens: 200_000, compacting: false })
    live.compaction('start')
    live.settle()
    expect(sent.at(-1)).toEqual({ contextTokens: 200_000, compacting: false })
  })

  it('sends a reading still waiting for its slot when the attempt ends', () => {
    const { sent, live } = tracker()
    live.reading(10_000)
    live.reading(20_000)
    live.settle()
    expect(sent.at(-1)).toEqual({ contextTokens: 20_000, compacting: false })
    vi.advanceTimersByTime(LIVE_CONTEXT_INTERVAL_MS)
    expect(sent).toHaveLength(2)
  })
})

describe('turn stream live context', () => {
  it('sends the turn’s whole live state on the wire and hands the latest to the snapshot', async () => {
    const emitted: ServerMessage[] = []
    let snapshot: LiveContext | undefined
    const stream = createTurnStream({
      chatId: 'chat-1',
      turnId: 'turn-1',
      agent: { id: 'single', name: 'Single' } as AgentConfig,
      liveMessages: new Map(),
      append: async () => undefined,
      emit: (message) => { emitted.push(message) },
      onContext: (context) => { snapshot = context },
    })
    const events: RuntimeEvent[] = [
      { type: 'context', contextTokens: 120_000 },
      { type: 'compaction', phase: 'start' },
      { type: 'compaction', phase: 'end', contextTokens: 40_000 },
      { type: 'result', text: 'Done.', contextTokens: 40_000 },
    ]
    async function* source() { yield* events }
    const outcome = await stream.consume({ events: source(), stop: () => undefined }, 'attempt-1')
    expect(outcome).toMatchObject({ kind: 'result', contextTokens: 40_000 })
    expect(emitted.filter((message) => message.type === 'turn_context')).toEqual([
      { type: 'turn_context', chatId: 'chat-1', turnId: 'turn-1', agentId: 'single', context: { contextTokens: 120_000, compacting: false } },
      { type: 'turn_context', chatId: 'chat-1', turnId: 'turn-1', agentId: 'single', context: { contextTokens: 120_000, compacting: true } },
      { type: 'turn_context', chatId: 'chat-1', turnId: 'turn-1', agentId: 'single', context: { contextTokens: 40_000, compacting: false, compacted: true } },
    ])
    expect(snapshot).toEqual({ contextTokens: 40_000, compacting: false, compacted: true })
  })

  it('settles a waiting reading when the driver throws, so nothing lands after the turn ends', async () => {
    vi.useFakeTimers()
    try {
      const emitted: ServerMessage[] = []
      const stream = createTurnStream({
        chatId: 'chat-1',
        turnId: 'turn-1',
        agent: { id: 'single', name: 'Single' } as AgentConfig,
        liveMessages: new Map(),
        append: async () => undefined,
        emit: (message) => { emitted.push(message) },
      })
      async function* source(): AsyncGenerator<RuntimeEvent> {
        yield { type: 'context', contextTokens: 10_000 }
        yield { type: 'context', contextTokens: 20_000 }
        throw new Error('driver died')
      }
      await expect(stream.consume({ events: source(), stop: () => undefined }, 'attempt-1')).rejects.toThrow('driver died')
      const sizes = () => emitted.flatMap((message) => (message.type === 'turn_context' ? [message.context.contextTokens] : []))
      expect(sizes()).toEqual([10_000, 20_000])
      vi.advanceTimersByTime(LIVE_CONTEXT_INTERVAL_MS * 2)
      expect(sizes()).toEqual([10_000, 20_000])
    } finally {
      vi.useRealTimers()
    }
  })
})
