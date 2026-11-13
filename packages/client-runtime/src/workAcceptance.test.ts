import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkAcceptance } from './commands'

afterEach(() => vi.useRealTimers())

describe('Work acceptance on both clients', () => {
  it('sends isolation and opens only after the matching ack', async () => {
    const acceptance = createWorkAcceptance()
    const send = vi.fn(() => true)
    const open = vi.fn()
    const runtime = { driver: 'codex' as const, model: 'gpt-6-astra', effort: 'high' as const }
    const result = acceptance.accept(send, 'accept-1', 'proposal-1', {
      mode: 'single', runtime, checkout: { mode: 'worktree' },
    }).then(open)
    expect(send).toHaveBeenCalledWith({
      type: 'accept_work_handoff', requestId: 'accept-1', handoffId: 'proposal-1',
      mode: 'single', runtime, checkout: { mode: 'worktree' },
    })
    acceptance.receive({ type: 'ack', requestId: 'unrelated' })
    await Promise.resolve()
    expect(open).not.toHaveBeenCalled()
    acceptance.receive({ type: 'ack', requestId: 'accept-1', workChatId: 'work-1' })
    await result
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith('work-1')
  })

  it('keeps Git refusal retryable without opening', async () => {
    const acceptance = createWorkAcceptance()
    const result = acceptance.accept(() => true, 'first', 'work-1', { mode: 'house' })
    acceptance.receive({ type: 'notice', requestId: 'first', text: 'Git refused', kind: 'error' })
    await expect(result).rejects.toThrow('Git refused')
    const retry = acceptance.accept(() => true, 'retry', 'work-1', { mode: 'house' })
    acceptance.receive({ type: 'ack', requestId: 'retry', workChatId: 'work-1' })
    await expect(retry).resolves.toBe('work-1')
  })

  it('releases the control on disconnect, send failure and missing confirmation', async () => {
    vi.useFakeTimers()
    const acceptance = createWorkAcceptance()
    await expect(acceptance.accept(() => false, 'offline', 'work-1', { mode: 'house' })).rejects.toThrow('Not connected')
    const interrupted = acceptance.accept(() => true, 'disconnect', 'work-1', { mode: 'house' })
    acceptance.cancel()
    await expect(interrupted).rejects.toThrow('Connection closed')
    const timedOut = acceptance.accept(() => true, 'timeout', 'work-1', { mode: 'house' })
    const assertion = expect(timedOut).rejects.toThrow('No confirmation')
    vi.advanceTimersByTime(60_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
})
