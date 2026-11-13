import type { Driver, ProviderUpdate, ServerMessage } from '@manor/contracts'
import { compareVersions } from './drivers/providerUpdate.js'

/**
 * House-wide "a provider CLI has a newer release", checked hourly while somebody is
 * connected and pushed to every client. Knows no CLI: it asks whichever drivers
 * offer `checkForUpdate`, and runs `installUpdate` only on an explicit request.
 * The one unasked install is `prepareRuntime`, for a runtime that is missing.
 * Cursor offers neither on purpose, it updates itself and publishes no version feed.
 */

type Provider = ProviderUpdate['provider']

const CHECK_EVERY_MS = 60 * 60_000
/** How long a finished update stays `updated` before its entry drops. */
const UPDATED_LINGER_MS = 10_000

export interface ProviderUpdateOptions {
  drivers: Partial<Record<Provider, Driver>>
  broadcast: (message: ServerMessage) => void
  checkEveryMs?: number
  updatedLingerMs?: number
}

export class ProviderUpdateService {
  private readonly entries = new Map<Provider, ProviderUpdate>()
  private readonly capable: Provider[]
  private readonly checkEveryMs: number
  private readonly updatedLingerMs: number
  private timer?: NodeJS.Timeout
  private clients = 0
  private checking?: Promise<void>
  /** Bumped per provider when an update starts; a check begun before it is stale. */
  private readonly generations = new Map<Provider, number>()

  constructor(private readonly options: ProviderUpdateOptions) {
    this.checkEveryMs = options.checkEveryMs ?? CHECK_EVERY_MS
    this.updatedLingerMs = options.updatedLingerMs ?? UPDATED_LINGER_MS
    this.capable = (Object.keys(options.drivers) as Provider[]).filter(
      (provider) => options.drivers[provider]?.checkForUpdate !== undefined,
    )
  }

  message(): Extract<ServerMessage, { type: 'provider_updates' }> {
    return { type: 'provider_updates', updates: [...this.entries.values()] }
  }

  /** The zero-to-one client edge checks at once, so a restart does not wait an hour. */
  setClientCount(count: number): void {
    const had = this.clients
    this.clients = count
    if (count > 0 && had === 0) void this.checkAll()
  }

  start(): void {
    void this.prepareAll()
    if (this.capable.length === 0 || this.timer !== undefined) return
    this.timer = setInterval(() => {
      if (this.clients > 0) void this.checkAll()
    }, this.checkEveryMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One check in flight at a time; a second caller waits on the first. */
  checkAll(): Promise<void> {
    this.checking ??= Promise.all(this.capable.map((provider) => this.check(provider)))
      .then(() => this.options.broadcast(this.message()))
      .finally(() => { this.checking = undefined })
    return this.checking
  }

  /** "Update all" without a provider. Entries already updating, or pinned, are skipped. */
  async install(provider?: Provider): Promise<void> {
    const targets = [...this.entries.values()].filter((entry) =>
      entry.canUpdate &&
      (entry.state === 'available' || entry.state === 'failed') &&
      (provider === undefined || entry.provider === provider) &&
      this.options.drivers[entry.provider]?.installUpdate !== undefined)
    if (targets.length === 0) return
    for (const entry of targets) this.generations.set(entry.provider, (this.generations.get(entry.provider) ?? 0) + 1)
    for (const entry of targets) this.entries.set(entry.provider, { provider: entry.provider, currentVersion: entry.currentVersion, latestVersion: entry.latestVersion, canUpdate: true, state: 'updating' })
    this.options.broadcast(this.message())
    await Promise.all(targets.map((entry) => this.installOne(entry.provider)))
    this.options.broadcast(this.message())
  }

  /**
   * A runtime Manor owns but has none of yet (Codex on a fresh start) installs at
   * once, as an `updating` entry with no current version, so the wait is visible
   * before a turn needs it.
   */
  private async prepareAll(): Promise<void> {
    await Promise.all((Object.keys(this.options.drivers) as Provider[]).map(async (provider) => {
      const pending = await this.options.drivers[provider]?.prepareRuntime?.().catch(() => null)
      if (pending == null) return
      this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1)
      const entry: ProviderUpdate = { provider, currentVersion: '', latestVersion: pending.version, canUpdate: true, state: 'updating' }
      this.entries.set(provider, entry)
      this.options.broadcast(this.message())
      const result = await pending.done.catch(() => ({ ok: false as const, reason: 'the install failed' }))
      if (result.ok) this.settleUpdated(provider, { ...entry, currentVersion: pending.version })
      else this.entries.set(provider, { ...entry, state: 'failed', error: result.reason })
      this.options.broadcast(this.message())
    }))
  }

  private settleUpdated(provider: Provider, entry: ProviderUpdate): void {
    this.entries.set(provider, { ...entry, state: 'updated' })
    setTimeout(() => {
      if (this.entries.get(provider)?.state !== 'updated') return
      this.entries.delete(provider)
      this.options.broadcast(this.message())
    }, this.updatedLingerMs).unref?.()
  }

  private async installOne(provider: Provider): Promise<void> {
    const driver = this.options.drivers[provider]!
    const before = this.entries.get(provider)!
    const result = await driver.installUpdate!().catch((error: unknown) => ({
      ok: false as const, reason: error instanceof Error ? error.message : 'the updater failed',
    }))
    if (!result.ok) {
      this.entries.set(provider, { ...before, state: 'failed', error: result.reason })
      return
    }
    // An updater that exits 0 is a claim. The version it left behind is the evidence.
    const after = await driver.checkForUpdate!().catch(() => null)
    if (after !== null && compareVersions(after.currentVersion, after.latestVersion) < 0) {
      this.entries.set(provider, { ...before, currentVersion: after.currentVersion, latestVersion: after.latestVersion, state: 'failed', error: `Still on ${after.currentVersion} after the update.` })
      return
    }
    if (after === null) {
      this.entries.set(provider, { ...before, state: 'failed', error: 'The updater finished, but the new version could not be confirmed.' })
      return
    }
    this.settleUpdated(provider, { ...before, currentVersion: after.currentVersion, latestVersion: after.currentVersion })
  }

  private async check(provider: Provider): Promise<void> {
    const existing = this.entries.get(provider)
    // A running or just-finished update owns its entry until it settles.
    if (existing?.state === 'updating' || existing?.state === 'updated') return
    const generation = this.generations.get(provider) ?? 0
    const result = await this.options.drivers[provider]!.checkForUpdate!().catch(() => null)
    // An update started while this check was in flight owns the entry, even after
    // it finished and its entry dropped: this reading predates it.
    if ((this.generations.get(provider) ?? 0) !== generation) return
    const settled = this.entries.get(provider)
    // Unknowable this hour (offline, registry down) keeps what was last known.
    if (result === null) return
    if (compareVersions(result.currentVersion, result.latestVersion) >= 0) {
      this.entries.delete(provider)
      return
    }
    // A failed update keeps its reason until a newer check says something else changed.
    if (settled?.state === 'failed' && settled.currentVersion === result.currentVersion && settled.latestVersion === result.latestVersion) return
    this.entries.set(provider, { provider, ...result, state: 'available' })
  }
}
