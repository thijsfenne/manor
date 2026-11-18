import { describe, expect, it, vi } from 'vitest'

import { watchForeground, type AppStateSource } from './appLifecycle'

function appState(currentState = 'active') {
  let listener: (state: string) => void = () => {}
  const remove = vi.fn()
  const source: AppStateSource = {
    currentState,
    addEventListener: (_type, next) => {
      listener = next
      return { remove }
    },
  }
  return { source, remove, emit: (state: string) => listener(state) }
}

describe('mobile foreground reconnect', () => {
  it('reconnects after a long absence or when not live, and refreshes push on every return', () => {
    let now = 0
    const state = appState()
    const onReconnect = vi.fn()
    const onForeground = vi.fn()
    let live = true
    const stop = watchForeground(state.source, { reconnectAfterMs: 10_000, isLive: () => live, onReconnect, onForeground, now: () => now })

    state.emit('background')
    now = 3_000
    state.emit('active')
    expect(onReconnect).not.toHaveBeenCalled()

    state.emit('background')
    now = 14_000
    state.emit('active')
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(onForeground).toHaveBeenCalledTimes(2)

    // Down before it left: a quick switch back retries now rather than after its backoff.
    live = false
    state.emit('background')
    now = 15_000
    state.emit('active')
    expect(onReconnect).toHaveBeenCalledTimes(2)

    stop()
    expect(state.remove).toHaveBeenCalled()
  })

  it('counts an absence that began before it was watching', () => {
    const state = appState('background')
    const onReconnect = vi.fn()
    const stop = watchForeground(state.source, { reconnectAfterMs: 10_000, isLive: () => false, onReconnect, onForeground: () => {}, now: () => 0 })
    state.emit('active')
    expect(onReconnect).toHaveBeenCalledOnce()
    stop()
  })
})
