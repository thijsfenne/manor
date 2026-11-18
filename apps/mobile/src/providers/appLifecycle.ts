/**
 * The part of React Native's `AppState` the providers listen to. Kept structural so
 * this module stays free of `react-native` and runs under plain vitest.
 */
export interface AppStateSource {
  currentState: string
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void }
}

export interface ForegroundOptions {
  /** How long the app must have been away before the socket is presumed dead. */
  reconnectAfterMs: number
  /** A connection that is not live retries on return instead of waiting out its backoff. */
  isLive: () => boolean
  onReconnect: () => void
  /** Runs on every return to the foreground, reconnect or not. */
  onForeground: () => void
  now?: () => number
}

/**
 * A socket left in the background for long may be dead without having said so, so a
 * long absence reconnects on return; a quick app switch keeps a live socket. A
 * connection that was already down retries at once, whatever the absence.
 * Returns the teardown.
 */
export function watchForeground(appState: AppStateSource, options: ForegroundOptions): () => void {
  const now = options.now ?? Date.now
  let backgroundedAt: number | null = appState.currentState === 'active' ? null : now()
  const subscription = appState.addEventListener('change', (state) => {
    if (state !== 'active') {
      backgroundedAt = now()
      return
    }
    if (backgroundedAt !== null && (!options.isLive() || now() - backgroundedAt >= options.reconnectAfterMs)) options.onReconnect()
    options.onForeground()
    backgroundedAt = null
  })
  return () => subscription.remove()
}
