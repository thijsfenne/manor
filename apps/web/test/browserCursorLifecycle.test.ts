import type { DesktopBrowserBridge, ServerMessage } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { BrowserCursorLifecycle } from '../src/browserCursorLifecycle'

const setup = () => {
  const endAgentUse = vi.fn(async () => {})
  const onEnd = vi.fn()
  const lifecycle = new BrowserCursorLifecycle(() => ({ endAgentUse }) as unknown as DesktopBrowserBridge, onEnd)
  return { lifecycle, endAgentUse, onEnd }
}

describe('browser cursor turn ownership', () => {
  it.each(['done', 'aborted', 'error'] as const)('clears on %s, independently of the provider', (state) => {
    const { lifecycle, endAgentUse, onEnd } = setup()
    const active = lifecycle.begin('chat', 'smith')
    lifecycle.receive({ type: 'turn_state', chatId: 'chat', turnId: 'turn', agentId: 'smith', state: 'running' })
    expect(active()).toBe(true)
    expect(endAgentUse).not.toHaveBeenCalled()
    lifecycle.receive({ type: 'turn_state', chatId: 'chat', turnId: 'turn', agentId: 'smith', state })
    expect(active()).toBe(false)
    expect(endAgentUse.mock.calls).toEqual([['chat']])
    expect(onEnd.mock.calls).toEqual([['chat']])
  })

  it('ends the shared home tabs when a browser session turn finishes', () => {
    const endAgentUse = vi.fn(async () => {})
    const lifecycle = new BrowserCursorLifecycle(
      () => ({ endAgentUse }) as unknown as DesktopBrowserBridge, undefined,
      (chatId) => chatId === 'pane' ? 'browser:home' : chatId,
    )
    const active = lifecycle.begin('browser:home', 'smith')
    lifecycle.receive({ type: 'turn_state', chatId: 'pane', turnId: 'turn', agentId: 'smith', state: 'done' })
    expect(active()).toBe(false)
    expect(endAgentUse.mock.calls).toEqual([['browser:home']])
  })

  it('keeps one owner across tools and ignores another agent finishing', () => {
    const { lifecycle, endAgentUse } = setup()
    const first = lifecycle.begin('chat', 'smith')
    lifecycle.begin('chat', 'smith')
    expect(first()).toBe(true)
    const next = lifecycle.begin('chat', 'wren')
    lifecycle.receive({ type: 'turn_state', chatId: 'chat', turnId: 'old', agentId: 'smith', state: 'done' })
    expect(first()).toBe(false)
    expect(next()).toBe(true)
    expect(endAgentUse).not.toHaveBeenCalled()
  })

  it('clears every owning chat on disconnect and invalidates pending tools', () => {
    const { lifecycle, endAgentUse } = setup()
    const first = lifecycle.begin('one', 'smith')
    const second = lifecycle.begin('two', 'smith')
    lifecycle.disconnect()
    lifecycle.disconnect()
    expect(first()).toBe(false)
    expect(second()).toBe(false)
    expect(endAgentUse.mock.calls).toEqual([['one'], ['two']])
  })

  it('works without a native browser and with an older shell', () => {
    for (const browser of [undefined, {} as DesktopBrowserBridge]) {
      const lifecycle = new BrowserCursorLifecycle(() => browser)
      lifecycle.begin('chat', 'smith')
      expect(() => lifecycle.disconnect()).not.toThrow()
    }
  })
})

describe('browser session hold', () => {
  const sessions = () => {
    const bridge = {
      beginAgentUse: vi.fn(async () => {}), endAgentUse: vi.fn(async () => {}), interruptAgentInput: vi.fn(async () => {}),
    }
    const lifecycle = new BrowserCursorLifecycle(() => bridge as unknown as DesktopBrowserBridge, undefined,
      (chatId) => chatId.startsWith('pane') ? 'browser:home' : chatId)
    return { lifecycle, bridge }
  }
  const turn = (chatId: string, turnId: string, agentId: string, state: 'running' | 'done' | 'aborted') =>
    ({ type: 'turn_state', chatId, turnId, agentId, state }) as ServerMessage

  it('holds the home tabs from turn start, never for an ordinary chat', () => {
    const { lifecycle, bridge } = sessions()
    lifecycle.receive(turn('pane', 't1', 'smith', 'running'))
    lifecycle.receive(turn('work', 't2', 'smith', 'running'))
    expect(bridge.beginAgentUse.mock.calls).toEqual([['browser:home']])
    lifecycle.receive(turn('pane', 't1', 'smith', 'done'))
    expect(bridge.endAgentUse.mock.calls).toEqual([['browser:home']])
  })

  it.each([['smith', 'smith'], ['smith', 'wren']])('releases only when the last overlapping turn settles (%s, %s)', (first, second) => {
    const { lifecycle, bridge } = sessions()
    lifecycle.receive(turn('pane-a', 't1', first, 'running'))
    lifecycle.receive(turn('pane-b', 't2', second, 'running'))
    lifecycle.receive(turn('pane-a', 't1', first, 'aborted'))
    expect(bridge.endAgentUse).not.toHaveBeenCalled()
    lifecycle.receive(turn('pane-b', 't2', second, 'done'))
    expect(bridge.endAgentUse.mock.calls).toEqual([['browser:home']])
  })

  it.each([['smith', 'smith'], ['smith', 'wren']])('cancels a tool with its own turn, not with a neighbour (%s, %s)', (first, second) => {
    const { lifecycle } = sessions()
    lifecycle.receive(turn('pane-a', 't1', first, 'running'))
    const toolA = lifecycle.begin('browser:home', first, 't1')
    lifecycle.receive(turn('pane-b', 't2', second, 'running'))
    const toolB = lifecycle.begin('browser:home', second, 't2')
    expect([toolA(), toolB()]).toEqual([true, true])
    lifecycle.receive(turn('pane-a', 't1', first, 'aborted'))
    expect([toolA(), toolB()]).toEqual([false, true])
    expect(lifecycle.begin('browser:home', first, 't1')()).toBe(false)
  })

  it('interrupts a stopped turn\'s running action while a neighbour keeps the tabs held', () => {
    const { lifecycle, bridge } = sessions()
    lifecycle.receive(turn('pane-a', 't1', 'smith', 'running'))
    lifecycle.receive(turn('pane-b', 't2', 'wren', 'running'))
    const answered = lifecycle.begin('browser:home', 'wren', 't2')
    lifecycle.finish(answered)
    lifecycle.begin('browser:home', 'smith', 't1')
    lifecycle.receive(turn('pane-b', 't2', 'wren', 'done'))
    expect(bridge.interruptAgentInput).not.toHaveBeenCalled()
    lifecycle.receive(turn('pane-a', 't1', 'smith', 'aborted'))
    // The last turn ending releases the session, which stops input on its own.
    expect(bridge.interruptAgentInput).not.toHaveBeenCalled()

    lifecycle.receive(turn('pane-a', 't3', 'smith', 'running'))
    lifecycle.receive(turn('pane-b', 't4', 'wren', 'running'))
    lifecycle.begin('browser:home', 'smith', 't3')
    lifecycle.receive(turn('pane-a', 't3', 'smith', 'aborted'))
    expect(bridge.interruptAgentInput.mock.calls).toEqual([['browser:home']])
    expect(bridge.endAgentUse).toHaveBeenCalledTimes(1)
  })

  it('keeps a tool from before a reconnect cancelled when its turn is held again', () => {
    const { lifecycle } = sessions()
    lifecycle.receive(turn('pane', 't1', 'smith', 'running'))
    const before = lifecycle.begin('browser:home', 'smith', 't1')
    lifecycle.disconnect()
    lifecycle.receive({ type: 'browser_session_turns', turnIds: ['t1'] })
    const after = lifecycle.begin('browser:home', 'smith', 't1')
    expect([before(), after()]).toEqual([false, true])
  })

  it('restores hidden sessions from the reconnect list and skips turns that already settled', () => {
    const { lifecycle, bridge } = sessions()
    lifecycle.receive(turn('pane', 't1', 'smith', 'running'))
    lifecycle.receive(turn('pane', 't1', 'smith', 'done'))
    lifecycle.receive(turn('pane', 't2', 'smith', 'running'))
    lifecycle.disconnect()
    expect(bridge.endAgentUse).toHaveBeenCalledTimes(2)

    // 'hidden' is a Browser session this client has not loaded, so sessionOf cannot place it.
    lifecycle.receive({ type: 'browser_session_turns', turnIds: ['t3', 't1'] })
    expect(bridge.beginAgentUse.mock.calls.at(-1)).toEqual(['browser:home'])
    const tool = lifecycle.begin('browser:home', 'wren', 't3')
    lifecycle.receive(turn('pane', 't1', 'smith', 'done'))
    expect(bridge.endAgentUse).toHaveBeenCalledTimes(2)
    lifecycle.receive(turn('hidden', 't3', 'wren', 'done'))
    expect(bridge.endAgentUse).toHaveBeenCalledTimes(3)
    expect(tool()).toBe(false)
  })

  it('restores the hold from a snapshot, but not for a turn that already settled', () => {
    const { lifecycle, bridge } = sessions()
    const snapshot = (turnId: string) => ({
      type: 'snapshot', chatId: 'pane', events: [], usage: {},
      activeTurn: { turnId, agentId: 'smith', startedAt: 0 },
    }) as ServerMessage
    lifecycle.receive(snapshot('t1'))
    expect(bridge.beginAgentUse.mock.calls).toEqual([['browser:home']])
    lifecycle.receive(turn('pane', 't1', 'smith', 'done'))
    expect(bridge.endAgentUse).toHaveBeenCalledTimes(1)
    lifecycle.receive(snapshot('t1'))
    expect(bridge.beginAgentUse).toHaveBeenCalledTimes(1)
  })
})
