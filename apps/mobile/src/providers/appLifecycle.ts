import type { ManorSession } from '@manor/client-runtime/auth'

/**
 * The part of React Native's `AppState` the providers listen to. Kept structural so
 * this module stays free of `react-native` and runs under plain vitest.
 */
export interface AppStateSource {
  currentState: string
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void }
}

/** The part of `ManorAuthClient` the auth provider drives. */
export interface AuthSessionClient {
  getSession(): Promise<ManorSession | null>
  subscribe(listener: (session: ManorSession | null) => void): () => void
  setActive(active: boolean): void
}

/**
 * Follows the stored session and keeps token refresh running only while the app is
 * in front. Every outcome reports a session, including a storage read that fails:
 * that lands as signed out, so the gate shows the login form (whose sign-in reads
 * storage again) instead of a spinner that never ends. A later read that recovers
 * arrives through `subscribe`. Returns the teardown.
 */
export function watchAuthSession(
  client: AuthSessionClient,
  appState: AppStateSource,
  onSession: (session: ManorSession | null) => void,
): () => void {
  let active = true
  client.getSession().then(
    (current) => { if (active) onSession(current) },
    () => { if (active) onSession(null) },
  )
  const unsubscribe = client.subscribe(onSession)
  const foreground = appState.addEventListener('change', (state) => {
    client.setActive(state === 'active')
  })
  client.setActive(appState.currentState === 'active')
  return () => {
    active = false
    unsubscribe()
    foreground.remove()
    client.setActive(false)
  }
}

export interface ForegroundOptions {
  /** How long the app must have been away before the socket is presumed dead. */
  reconnectAfterMs: number
  onReconnect: () => void
  /** Runs on every return to the foreground, reconnect or not. */
  onForeground: () => void
  now?: () => number
}

/**
 * A socket left in the background for long may be dead without having said so, so a
 * long absence reconnects on return; a quick app switch keeps the live socket.
 * Returns the teardown.
 */
export function watchForeground(appState: AppStateSource, options: ForegroundOptions): () => void {
  const now = options.now ?? Date.now
  let backgroundedAt: number | null = null
  const subscription = appState.addEventListener('change', (state) => {
    if (state !== 'active') {
      backgroundedAt = now()
      return
    }
    if (backgroundedAt !== null && now() - backgroundedAt >= options.reconnectAfterMs) options.onReconnect()
    options.onForeground()
    backgroundedAt = null
  })
  return () => subscription.remove()
}
