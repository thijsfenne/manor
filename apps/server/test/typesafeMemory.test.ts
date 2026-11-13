import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTypesafeMemoryRanker, rankTypesafeMemory } from '../src/drivers/typesafeMemory.js'

const response = (answers: Record<string, { type: string; noul: number }> = { memory_0: { type: 'noul', noul: 0.95 }, memory_1: { type: 'noul', noul: 0.3 } }) =>
  new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 200, output_tokens: 20 } }))

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('TypeSafe memory ranking', () => {
  it('retains lexical selection without credentials and applies the calibrated cutoff', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      memory_0: { type: 'noul', noul: 0.75 }, memory_1: { type: 'noul', noul: 0.74 },
    }))
    vi.stubGlobal('fetch', fetch)
    expect(createTypesafeMemoryRanker(undefined)).toBeUndefined()
    expect(createTypesafeMemoryRanker('  ')).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    await expect(createTypesafeMemoryRanker('test')!('current question', ['one', 'two'], 'Manor')).resolves.toEqual([0.75, 0])
  })

  it('batches every candidate afresh on consecutive turns and permits no matches', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response({
      memory_0: { type: 'noul', noul: 0.2 }, memory_1: { type: 'noul', noul: 0.1 },
    }))
    vi.stubGlobal('fetch', fetch)
    const rows = ['Cloud hosting', 'Facial motion']
    expect((await rankTypesafeMemory('test', 'hosting', rows, 'Manor')).scores).toEqual([0.95, 0])
    expect((await rankTypesafeMemory('test', 'hosting\nja', rows, 'Manor', 'ja')).scores).toEqual([0, 0])
    expect(fetch).toHaveBeenCalledTimes(2)
    const body = JSON.parse(fetch.mock.calls[1]![1].body)
    expect(body.state).toEqual({ project: 'Manor', earlier_messages: 'hosting', current_request: 'ja', candidates: { memory_0: rows[0], memory_1: rows[1] } })
    expect(Object.keys(body.questions)).toEqual(['memory_0', 'memory_1'])
  })

  it('rejects missing or invalid scores instead of quietly dropping memories', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ memory_0: { type: 'noul', noul: 0.95 } }))
      .mockResolvedValueOnce(response({ memory_0: { type: 'noul', noul: 2 }, memory_1: { type: 'noul', noul: 0.1 } }))
      .mockRejectedValueOnce(new Error('private provider body'))
    vi.stubGlobal('fetch', fetch)
    for (let i = 0; i < 3; i++) {
      await expect(rankTypesafeMemory('test', 'cloud', ['one', 'two'], 'Manor')).rejects.toThrow('TypeSafe memory ranking unavailable')
    }
  })

  it('bounds the response body wait and aborts without retry', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) })
    vi.stubGlobal('fetch', fetch)
    const pending = expect(rankTypesafeMemory('test', 'cloud', ['one'], 'Manor')).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(600)
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(600)
    await pending
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['headers', 'body'] as const)('handles a late %s rejection after the timeout has settled', async (phase) => {
    vi.useFakeTimers()
    const unhandled = vi.fn()
    const aborted = vi.fn()
    process.on('unhandledRejection', unhandled)
    const fetch = vi.fn(async (_url: unknown, { signal }: RequestInit) => {
      const waiting = new Promise<never>((_, reject) => {
        signal!.addEventListener('abort', () => {
          setTimeout(() => {
            aborted()
            reject(new DOMException('The operation was aborted', 'AbortError'))
          }, 10)
        }, { once: true })
      })
      return phase === 'headers' ? waiting : { ok: true, json: () => waiting }
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const pending = expect(rankTypesafeMemory('test', 'cloud', ['one'], 'Manor')).rejects.toThrow('unavailable')
      await vi.advanceTimersByTimeAsync(1_200)
      await pending
      expect(aborted).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10)
      vi.useRealTimers()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(aborted).toHaveBeenCalledOnce()
      expect(unhandled).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      process.removeListener('unhandledRejection', unhandled)
    }
  })
})
