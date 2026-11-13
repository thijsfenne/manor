import { ManorSessionSchema, type ManorSession } from '@manor/contracts'
export type { ManorSession } from '@manor/contracts'

export interface AuthStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

export class ManorAuthClient {
  private session: ManorSession | null = null
  private loaded: Promise<void> | undefined
  private loadFailed = false
  private listeners = new Set<(session: ManorSession | null) => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private refreshing: Promise<void> | undefined
  private revision = 0
  private readonly storageKey: string
  constructor(private origin: string, private storage: AuthStorage, private fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.storageKey = `manor.auth.${Array.from(origin, (char) => char.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`
  }
  /**
   * Reads the stored session once. A failed read is forgotten, so the next caller
   * (sign-in, or the background timer) asks storage again instead of inheriting
   * the rejection forever. A read that recovers after a failure is announced to
   * listeners, because the adapter already showed the signed-out door by then.
   */
  private load(): Promise<void> {
    if (this.loaded !== undefined) return this.loaded
    const loaded: Promise<void> = Promise.resolve()
      .then(() => this.storage.getItem(this.storageKey))
      .then(
        (raw) => {
          if (raw !== null) {
            try { this.session = ManorSessionSchema.parse(JSON.parse(raw)) } catch { this.session = null }
          }
          if (!this.loadFailed) return
          this.loadFailed = false
          for (const listener of this.listeners) listener(this.session)
        },
        (error: unknown) => {
          if (this.loaded === loaded) this.loaded = undefined
          this.loadFailed = true
          throw error
        },
      )
    this.loaded = loaded
    return loaded
  }
  /** Listeners hear the new session even when persisting it fails; the error still surfaces. */
  private async apply(session: ManorSession | null): Promise<void> {
    this.session = session
    try {
      if (session === null) await this.storage.removeItem(this.storageKey)
      else await this.storage.setItem(this.storageKey, JSON.stringify(session))
    } finally {
      for (const listener of this.listeners) listener(session)
    }
  }
  async getSession(): Promise<ManorSession | null> {
    await this.load()
    if (this.session !== null && this.session.expires_at * 1000 <= Date.now() + 60_000) await this.refresh()
    return this.session
  }
  subscribe(listener: (session: ManorSession | null) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private request(route: string, body: object) {
    return this.fetcher(`${this.origin}/auth/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
  }
  async signIn(email: string, password: string): Promise<string | null> {
    try { await this.load() } catch { return 'Manor could not read the saved sign-in on this device. Try again.' }
    const revision = ++this.revision
    let session: ManorSession
    try {
      const response = await this.request('session', { email, password })
      if (response.status >= 500) return 'Manor cannot sign in right now. Try again shortly.'
      if (!response.ok) return response.status === 429 ? 'Too many attempts. Try again in a minute.' : 'Unable to sign in. Check your email and password.'
      session = ManorSessionSchema.parse(await response.json())
    } catch { return 'Cannot reach Manor. Check that your Mac is awake and Manor is running.' }
    // A session that cannot be persisted still holds for this run; the next launch asks again.
    if (revision === this.revision) await this.apply(session).catch(() => undefined)
    return null
  }
  /**
   * Always ends the session in memory, tells listeners, and asks the server to
   * revoke the refresh token, even when local storage refuses to read or remove.
   * A copy left on disk then fails its next refresh with 401 and clears itself.
   */
  async signOut(): Promise<void> {
    try { await this.load() } catch { /* Whatever is in memory is still signed out below. */ }
    ++this.revision
    const held = this.session
    await this.apply(null).catch(() => undefined)
    if (held !== null) {
      try { await this.request('logout', { refresh_token: held.refresh_token }) } catch { /* Local sign-out still succeeds offline. */ }
    }
  }
  refresh(): Promise<void> {
    if (this.refreshing !== undefined) return this.refreshing
    this.refreshing = this.refreshOnce().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  private async refreshOnce(): Promise<void> {
    try { await this.load() } catch { return /* Nothing readable to refresh; the next tick reads again. */ }
    const held = this.session
    const revision = this.revision
    if (held === null) return
    try {
      const response = await this.request('refresh', { refresh_token: held.refresh_token })
      if (revision !== this.revision) return
      if (response.status === 401) await this.apply(null)
      else if (response.ok) {
        const session = ManorSessionSchema.parse(await response.json())
        if (revision === this.revision) await this.apply(session)
      }
    } catch { /* A network interruption is not a revoked session. */ }
  }
  setActive(active: boolean): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (!active) return
    // Each tick doubles as the storage retry; its failure is the adapter's to show, not an unhandled rejection.
    const tick = () => { this.getSession().catch(() => undefined) }
    tick()
    this.timer = setInterval(tick, 30_000)
  }
}
