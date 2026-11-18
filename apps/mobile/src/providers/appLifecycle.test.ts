import { ManorAuthClient, type ManorSession } from '@manor/client-runtime/auth'
import { describe, expect, it, vi } from 'vitest'

import { watchAuthSession, watchForeground, type AppStateSource } from './appLifecycle'

const session: ManorSession = {
  access_token: 'access-token',
  refresh_token: 'refresh-token-long-enough',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.invalid' },
}

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

describe('mobile auth session wiring', () => {
  it('lands on the login gate when SecureStore fails, then recovers through sign-in', async () => {
    const values = new Map<string, string>()
    let locked = true
    const store = {
      getItem: async (key: string) => {
        if (locked) throw new Error('keychain locked')
        return values.get(key) ?? null
      },
      setItem: async (key: string, value: string) => { values.set(key, value) },
      removeItem: async (key: string) => { values.delete(key) },
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify(session)))
    const client = new ManorAuthClient('http://mac.local:43179', store, fetcher)
    const onSession = vi.fn()
    const stop = watchAuthSession(client, appState('background').source, onSession)

    await vi.waitFor(() => expect(onSession).toHaveBeenCalledWith(null))
    locked = false
    expect(await client.signIn('owner@example.invalid', 'password')).toBeNull()
    expect(onSession).toHaveBeenLastCalledWith(session)
    stop()
  })

  it('refreshes tokens only while the app is in front and stops on teardown', () => {
    const client = { getSession: vi.fn().mockResolvedValue(null), subscribe: vi.fn(() => () => {}), setActive: vi.fn() }
    const state = appState('active')
    const stop = watchAuthSession(client, state.source, () => {})
    state.emit('background')
    state.emit('active')
    stop()
    expect(client.setActive.mock.calls).toEqual([[true], [false], [true], [false]])
    expect(state.remove).toHaveBeenCalled()
  })
})

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
