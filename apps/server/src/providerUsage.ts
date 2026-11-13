import type { Driver, ProviderUsage, ServerMessage } from '@manor/contracts'
import type { ProviderUsageHistory } from './providerUsageHistory.js'

/**
 * House-wide subscription headroom, kept in one place and pushed to every client.
 *
 * This module knows no CLI. It asks whichever drivers offer `readProviderUsage`
 * and owns everything around that call: when to ask, how often, what to show while
 * a probe is in flight, and when a run of failures stops being a blip. A driver
 * without the capability contributes nothing, which is how the mock stays honest.
 */

export type UsageProvider = ProviderUsage['provider']

/** Least often a provider is asked, however many turns end in that window. */
const DEBOUNCE_MS = 60_000
/** Background refresh while somebody is watching. */
const REFRESH_MS = 15 * 60_000
/** Failures in a row before the last good reading stops being shown. */
const FAILURE_LIMIT = 3
/** An explicit refresh skips the debounce, but not a reading this recent. */
const REFRESH_FLOOR_MS = 10_000

export interface ProviderUsageOptions {
  /** The built drivers, by provider. Absent or capability-less ones are skipped. */
  drivers: Partial<Record<UsageProvider, Driver | Pick<Driver, 'readProviderUsage'>>>
  broadcast: (message: ServerMessage) => void
  now?: () => number
  debounceMs?: number
  refreshMs?: number
  failureLimit?: number
  history?: ProviderUsageHistory
}

interface ProviderState {
  /** The last reading worth showing. Undefined until the first successful probe. */
  last?: ProviderUsage
  failures: number
  probing: boolean
  /**
   * When this provider was last asked. Undefined means never, which is not the same
   * as "at zero": a debounce measured from epoch zero would swallow the very first
   * probe of the process on any clock that does not start in the billions.
   */
  lastProbeAt?: number
  /** A probe asked for during a debounce window, to run when that window closes. */
  queued: boolean
}

export class ProviderUsageService {
  private readonly options: Required<Omit<ProviderUsageOptions, 'drivers' | 'broadcast' | 'history'>> &
    Pick<ProviderUsageOptions, 'drivers' | 'broadcast' | 'history'>
  private readonly states = new Map<UsageProvider, ProviderState>()
  private readonly capable: UsageProvider[]
  private timer?: NodeJS.Timeout
  private clients = 0

  constructor(options: ProviderUsageOptions) {
    this.options = {
      now: Date.now,
      debounceMs: DEBOUNCE_MS,
      refreshMs: REFRESH_MS,
      failureLimit: FAILURE_LIMIT,
      ...options,
    }
    this.capable = (Object.keys(options.drivers) as UsageProvider[]).filter(
      (provider) => options.drivers[provider]?.readProviderUsage !== undefined,
    )
    for (const provider of this.capable) {
      this.states.set(provider, { failures: 0, probing: false, queued: false })
    }
  }

  /** True when no driver in this house can answer, so nothing should be wired up. */
  get enabled(): boolean {
    return this.capable.length > 0
  }

  /**
   * What every client gets on connect and after every probe. Possibly stale, and
   * stamped so the panel can say how stale; a provider that has never answered
   * appears as `unavailable` rather than not appearing, because "we cannot see
   * Codex" is a fact worth showing and an absent section is not.
   */
  message(): Extract<ServerMessage, { type: 'provider_usage' }> {
    const now = this.options.now()
    return {
      type: 'provider_usage',
      perProvider: this.capable.map(
        (provider) =>
          this.states.get(provider)?.last ?? {
            provider,
            status: 'unavailable' as const,
            fetchedAt: now,
            windows: [],
          },
      ),
    }
  }

  /**
   * Client count as it changes. The zero-to-one edge probes immediately: without
   * it every server restart shows an empty panel for up to a whole refresh
   * interval while both accounts are perfectly reachable.
   */
  setClientCount(count: number): void {
    const had = this.clients
    this.clients = count
    if (count > 0 && had === 0) this.refreshAll()
  }

  /**
   * One provider's turn just ended, whatever way it ended. Failed and aborted
   * turns can have burned quota too, so this is called for every terminal state
   * rather than only for success.
   */
  noteTurnEnded(provider: UsageProvider): void {
    this.probe(provider)
  }

  /** Background refresh, armed only while somebody is connected. */
  start(): void {
    if (!this.enabled || this.timer !== undefined) return
    this.timer = setInterval(() => {
      if (this.clients > 0) this.refreshAll()
    }, this.options.refreshMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * The user pressed refresh on the Usage view. Every provider not read in the last few
   * seconds is asked now, past the turn debounce. When nobody is asked, the current
   * readings go out anyway, so the button that asked always hears back.
   */
  refreshNow(): void {
    let asked = false
    for (const provider of this.capable) {
      const state = this.states.get(provider)
      if (state === undefined) continue
      if (state.probing) {
        asked = true
        continue
      }
      if (state.lastProbeAt !== undefined && this.options.now() - state.lastProbeAt < REFRESH_FLOOR_MS) continue
      this.probe(provider, true)
      asked = true
    }
    if (!asked) this.options.broadcast(this.message())
  }

  private refreshAll(): void {
    for (const provider of this.capable) this.probe(provider)
  }

  private probe(provider: UsageProvider, force = false): void {
    const state = this.states.get(provider)
    const read = this.options.drivers[provider]?.readProviderUsage
    if (state === undefined || read === undefined) return

    // One in flight at a time, and never more than one per debounce window. A
    // queued flag rather than a dropped request, so a turn that ends inside the
    // window still gets its reading, just late.
    if (state.probing) {
      state.queued = true
      return
    }
    if (!force && state.lastProbeAt !== undefined && this.options.now() - state.lastProbeAt < this.options.debounceMs) {
      state.queued = true
      return
    }

    state.probing = true
    state.lastProbeAt = this.options.now()
    void read()
      .then((usage) => this.settle(provider, usage))
      .catch(() => {
        // A driver is documented never to reject. Treat one that does as a failure
        // rather than letting it take the process down.
        this.settle(provider, { provider, status: 'unavailable', fetchedAt: this.options.now(), windows: [] })
      })
  }

  private settle(provider: UsageProvider, usage: ProviderUsage): void {
    const state = this.states.get(provider)
    if (state === undefined) return
    state.probing = false

    if (usage.status === 'ok') {
      state.failures = 0
      state.last = usage
      try {
        state.last = this.options.history?.record(usage) ?? usage
      } catch {
        // A history read/write failure must not turn a real account reading into
        // an unavailable provider. Missing history stays explicit on the wire.
        state.last = { ...usage, windows: usage.windows.map(({ history: _history, ...window }) => window) }
      }
    } else {
      state.failures += 1
      // One failed probe keeps the last good reading on screen, still stamped with
      // the moment it was true. Only a run of them means the provider is really
      // unreachable, and then the panel says so instead of showing an old number
      // forever.
      if (state.failures >= this.options.failureLimit || state.last === undefined) state.last = usage
    }

    this.options.broadcast(this.message())

    if (state.queued) {
      state.queued = false
      // Straight after a probe the debounce is closed, so this lands on the next
      // window rather than immediately. Deliberate: the queued request exists so
      // the reading is not lost, not so it is instant.
      setTimeout(() => this.probe(provider), this.options.debounceMs).unref?.()
    }
  }
}

const PROVIDER_NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', cursor: 'Cursor' }

function untilText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * The Ledger's Limits readings as one block for a project thread's turn (2026-10-11),
 * so the runtime it proposes on a card can react to a nearly spent window. Remaining
 * percent per window, the way the Limits tab reads; empty when no provider reports.
 */
export function headroomNote(perProvider: readonly ProviderUsage[], now: number): string {
  if (perProvider.length === 0) return ''
  const lines = perProvider.map((usage) => {
    const name = PROVIDER_NAMES[usage.provider]
    if (usage.status !== 'ok' || usage.windows.length === 0) return `- ${name}: unavailable`
    const windows = usage.windows.map((window) => {
      const left = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)))
      const reset = window.resetsAt === undefined ? '' : `, resets in ${untilText(window.resetsAt - now)}`
      return `${window.label} ${left}% left${reset}`
    })
    const age = now - usage.fetchedAt > 10 * 60_000 ? ` (read ${untilText(now - usage.fetchedAt)} ago)` : ''
    return `- ${name}: ${windows.join('; ')}${age}`
  })
  return ['[Manor] Remaining subscription limits now, for the runtime you propose on a start_work card:', ...lines].join('\n')
}
