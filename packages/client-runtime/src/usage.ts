import type { ProviderConnection, ProviderUsage, UsageWindow } from '@manor/contracts'

/**
 * How much of each subscription is left, for the whole house: the pure reading
 * behind both the web sidebar's Usage panel and the mobile Usage screen. It lives
 * here so the two clients can never drift on what a percentage, a heat level or a
 * reset label means.
 *
 * This is subscription spend, including work done outside Manor. It is not how
 * full a conversation is, which is why the two never share a surface.
 *
 * Observations are always the provider's own. An optional projection extrapolates
 * those observations and stays separate from measured consumption.
 */

/** Two refresh intervals. Past this the reading is old enough to say so. */
export const STALE_AFTER_MS = 30 * 60_000
/** Where a percentage stops being ordinary, when the provider does not say. */
export const WARN_AT = 80
export const CRITICAL_AT = 95

export type Heat = 'normal' | 'warn' | 'critical'

/**
 * The provider's own alarm level wins. Claude reports one per window; Codex does
 * not, and there a threshold is the only thing available.
 */
export function heatOf(limit: UsageWindow): Heat {
  if (limit.severity === 'critical') return 'critical'
  if (limit.severity === 'warning') return 'warn'
  if (limit.severity === 'normal') return 'normal'
  if (limit.usedPercent >= CRITICAL_AT) return 'critical'
  if (limit.usedPercent >= WARN_AT) return 'warn'
  return 'normal'
}

/**
 * One provider's ring in the rail: its fullest window, since any full window is
 * the one that stops work. Undefined for a provider that did not answer or
 * reported no window, which the rail then leaves out rather than drawing empty.
 */
export function providerPeak(usage: ProviderUsage): UsageWindow | undefined {
  if (usage.status !== 'ok') return undefined
  return usage.windows.reduce<UsageWindow | undefined>(
    (fullest, limit) => (fullest === undefined || limit.usedPercent > fullest.usedPercent ? limit : fullest),
    undefined,
  )
}

/** One provider's usage ring: what is left of its fullest window, and how alarming that is. */
export interface UsageRing {
  provider: ProviderUsage['provider']
  left: number
  heat: Heat
}

/** The ring for one provider, or undefined when it has no window to draw. */
export function usageRing(usage: ProviderUsage): UsageRing | undefined {
  const limit = providerPeak(usage)
  return limit === undefined ? undefined : { provider: usage.provider, left: remainingPercent(limit), heat: heatOf(limit) }
}

/**
 * The readings worth showing: a provider whose sign-in row says it is missing or
 * signed out has nothing to show. One with no row yet keeps its reading, the same
 * benefit of the doubt the first-run screen gives it.
 */
export function connectedUsage(
  perProvider: readonly ProviderUsage[],
  connections: readonly ProviderConnection[],
): ProviderUsage[] {
  return perProvider.filter((usage) => {
    const row = connections.find((connection) => connection.provider === usage.provider)
    return row === undefined || row.state === 'ready' || row.state === 'attention'
  })
}

/** The providers the phone header always names, in this order, when they report. */
const HEADER_FIRST: readonly ProviderUsage['provider'][] = ['claude', 'codex']

/**
 * The phone header's usage pill: Claude, then Codex, as rings; every other
 * connected provider with a window counts toward `more`. With neither of the two
 * reporting, the first other one takes the ring, so the pill never reads as a bare
 * number.
 */
export function headerRings(
  perProvider: readonly ProviderUsage[],
  connections: readonly ProviderConnection[],
): { rings: UsageRing[]; more: number } {
  const all = connectedUsage(perProvider, connections)
    .sort(byCardOrder)
    .flatMap((usage) => usageRing(usage) ?? [])
  const first = HEADER_FIRST.flatMap((provider) => all.find((ring) => ring.provider === provider) ?? [])
  const rest = all.filter((ring) => !HEADER_FIRST.includes(ring.provider))
  const rings = first.length > 0 ? first : rest.slice(0, 1)
  return { rings, more: all.length - rings.length }
}

/** Matches provider usage displays: a real non-zero fraction should not read as zero. */
export function displayPercent(value: number): number {
  const clamped = Math.max(0, Math.min(100, value))
  return clamped > 0 && clamped < 1 ? 1 : Math.round(clamped)
}

/** The clock the whole app prints: 24 hours, two digits each, whatever the device's region says. */
const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

/** "resets in 42m" while that is a useful thing to say, a clock time once it is not. */
export function resetLabel(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return ''
  const minutes = Math.round((resetsAt - now) / 60_000)
  if (minutes <= 0) return 'resetting'
  if (minutes < 60) return `resets in ${String(minutes)}m`
  if (minutes < 12 * 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest === 0 ? `resets in ${String(hours)}h` : `resets in ${String(hours)}h ${String(rest)}m`
  }
  const when = new Date(resetsAt)
  const time = CLOCK.format(when)
  // Beyond half a day "in 19 hours" is arithmetic the reader has to undo, so the
  // weekly window says which day it lands on instead.
  const sameDay = new Date(now).toDateString() === when.toDateString()
  // The weekday is interface text, so it stays English whatever the device's language.
  return sameDay
    ? `resets ${time}`
    : `resets ${when.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

export const clockOf = (at: number) => CLOCK.format(new Date(at))

/**
 * Optional explanatory copy for provider-specific usage windows.
 */
export const WINDOW_DETAILS: Partial<Record<ProviderUsage['provider'], Record<string, string>>> = {}

/**
 * The cards' reading order, a house choice rather than the server's probe order.
 * Claude and Cursor report the most windows, so their taller cards take the top
 * row and the single-window providers close it. Anything not listed lands at the
 * end, in the order it arrived.
 */
const CARD_ORDER: readonly ProviderUsage['provider'][] = ['claude', 'cursor', 'grok', 'codex']

export const byCardOrder = (a: ProviderUsage, b: ProviderUsage): number => {
  const rank = (provider: ProviderUsage['provider']) => {
    const at = CARD_ORDER.indexOf(provider)
    return at === -1 ? CARD_ORDER.length : at
  }
  return rank(a.provider) - rank(b.provider)
}

/** Shared graph data for desktop and phone; 100% is the provider quota boundary. */
export function subscriptionGraph(usage: ProviderUsage, window: UsageWindow, now: number) {
  const resetsAt = window.resetsAt !== undefined && Number.isFinite(window.resetsAt) ? window.resetsAt : undefined
  const duration = window.minutes !== undefined && Number.isFinite(window.minutes) && window.minutes > 0
    ? window.minutes * 60_000 : undefined
  const candidateStart = window.startsAt ?? (resetsAt !== undefined && duration !== undefined ? resetsAt - duration : undefined)
  const startsAt = candidateStart !== undefined && Number.isFinite(candidateStart)
    && resetsAt !== undefined && candidateStart < resetsAt ? candidateStart : undefined
  const points = (window.history ?? []).filter((point) => Number.isFinite(point.at)
    && Number.isFinite(point.usedPercent) && point.usedPercent >= 0
    && point.at <= now && point.at <= usage.fetchedAt
    && (startsAt === undefined || point.at >= startsAt)
    && (resetsAt === undefined || point.at < resetsAt))
    .sort((a, b) => a.at - b.at)
    .filter((point, index, all) => point.at !== all[index + 1]?.at)
  const first = points[0]
  const last = points.at(-1)
  const segments: (typeof points)[] = []
  for (const point of points) {
    const segment = segments.at(-1)
    const previous = segment?.at(-1)
    if (segment === undefined || previous === undefined || point.at - previous.at > STALE_AFTER_MS) segments.push([point])
    else segment.push(point)
  }
  const base = { points, segments, startsAt, resetsAt, limitPercent: 100 as const }
  const without = (reason: 'unavailable' | 'history-unavailable' | 'unknown-period' | 'reset-pending'
    | 'stale' | 'insufficient-history' | 'usage-decreased') => ({
    ...base, projection: null, projectionUnavailableReason: reason,
  })

  if (usage.status !== 'ok') return without('unavailable')
  if (window.history === undefined) return without('history-unavailable')
  if (startsAt === undefined || resetsAt === undefined) return without('unknown-period')
  if (now >= resetsAt) return without('reset-pending')
  if (usage.fetchedAt > now || now - usage.fetchedAt >= STALE_AFTER_MS
    || (last !== undefined && now - last.at >= STALE_AFTER_MS)) return without('stale')
  // Three observations over at least 5% of the period, and never under 30 minutes.
  // This is a pacing estimate, not a prediction of future activity.
  if (first === undefined || last === undefined || points.length < 3
    || last.at - first.at < Math.max(30 * 60_000, (resetsAt - startsAt) * 0.05)) return without('insufficient-history')
  if (points.some((point, index) => index > 0 && point.usedPercent < (points[index - 1]?.usedPercent ?? 0))) {
    return without('usage-decreased')
  }
  // Cumulative readings in the same reset period measure the total change even
  // across offline gaps. Segments keep the unknown timing inside those gaps visible.
  const rate = (last.usedPercent - first.usedPercent) / (last.at - first.at)
  const projectedPercent = last.usedPercent + rate * (resetsAt - last.at)
  if (!Number.isFinite(projectedPercent)) return without('insufficient-history')
  return {
    ...base,
    projectionUnavailableReason: null,
    projection: {
      method: 'observed-rate' as const,
      from: last,
      to: { at: resetsAt, usedPercent: projectedPercent },
      // Never clamp to 100: exceeding the limit is what the estimate must reveal.
      reachesLimitAt: last.usedPercent >= 100 ? last.at
        : rate > 0 && projectedPercent >= 100 ? last.at + (100 - last.usedPercent) / rate : null,
    },
  }
}

/** Quota left in a window, 0..100. The Limits view shows what remains, as Codex does. */
export function remainingPercent(limit: UsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, limit.usedPercent)))
}

/**
 * How far into its window the clock is, 0..1. Null when the provider gave no reset
 * moment, or neither a start nor a length to measure from.
 */
export function elapsedShare(limit: UsageWindow, now: number): number | null {
  if (limit.resetsAt === undefined) return null
  const startsAt = limit.startsAt ?? (limit.minutes === undefined ? undefined : limit.resetsAt - limit.minutes * 60_000)
  if (startsAt === undefined || limit.resetsAt <= startsAt) return null
  return Math.max(0, Math.min(1, (now - startsAt) / (limit.resetsAt - startsAt)))
}

/**
 * Where even spending would put a bar that shows quota left: the share of the
 * window's time still to run, 0..100. Null when the provider gave no window timing.
 */
export function paceMarkPercent(limit: UsageWindow, now: number): number | null {
  const elapsed = elapsedShare(limit, now)
  return elapsed === null ? null : Math.round((1 - elapsed) * 100)
}

export type LimitPace = 'ahead' | 'on' | 'under'

/**
 * Usage against the clock. Spending evenly uses the same share of
 * quota as of time; within five points counts as on pace, further ahead means the
 * window may run dry before it resets.
 */
export function paceOf(limit: UsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(limit, now)
  if (elapsed === null) return null
  const gap = limit.usedPercent - elapsed * 100
  if (gap > 5) return 'ahead'
  if (gap < -5) return 'under'
  return 'on'
}

/** The hover text for each pace. */
export const PACE_LABEL: Record<LimitPace, string> = {
  ahead: 'Using quota faster than time passes. This window may run out before it resets.',
  on: 'Using quota about as fast as time passes.',
  under: 'Using quota slower than time passes. There is room left in this window.',
}

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const minutesTotal = Math.floor(Math.max(0, ms) / 60_000)
  const days = Math.floor(minutesTotal / (24 * 60))
  const hours = Math.floor((minutesTotal % (24 * 60)) / 60)
  const minutes = minutesTotal % 60
  if (days > 0) return `${String(days)}d ${String(hours)}h`
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`
  return `${String(minutes)}m`
}

/** `resets in 2h 13m`, `resets now`, or null when the window states no reset. */
export function resetsIn(limit: UsageWindow, now: number): string | null {
  if (limit.resetsAt === undefined) return null
  return limit.resetsAt <= now ? 'resets now' : `resets in ${formatDuration(limit.resetsAt - now)}`
}
