import type { ProviderUsage } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { byCardOrder, displayPercent, elapsedShare, formatDuration, heatOf, paceOf, peakUsed, providerPeak, remainingPercent, resetLabel, resetsIn, subscriptionGraph } from './usage'

const claude: ProviderUsage = {
  provider: 'claude',
  status: 'ok',
  plan: 'max',
  fetchedAt: 1_000,
  windows: [
    { label: '5-hour limit', usedPercent: 63, severity: 'normal', binding: false },
    { label: 'Weekly', usedPercent: 74, severity: 'normal', binding: true },
    { label: 'Weekly Fable', usedPercent: 45, severity: 'normal', binding: false },
  ],
}

const codex: ProviderUsage = {
  provider: 'codex',
  status: 'ok',
  plan: 'plus',
  fetchedAt: 1_000,
  windows: [{ label: 'Weekly', usedPercent: 4, minutes: 10080 }],
}

describe('peakUsed', () => {
  it('takes the fullest window that is not yet full', () => {
    expect(peakUsed([claude, codex])).toBe(74)
  })

  it('skips a full window and takes the next fullest', () => {
    const spent: ProviderUsage = {
      ...claude,
      windows: [
        { label: 'Weekly', usedPercent: 100, severity: 'critical', binding: true },
        { label: '5-hour limit', usedPercent: 63, severity: 'normal', binding: false },
      ],
    }
    expect(peakUsed([spent, codex])).toBe(63)
  })

  it('is 100 only when every returned window is full', () => {
    const spent: ProviderUsage = {
      ...claude,
      windows: [
        { label: 'Weekly', usedPercent: 100, severity: 'critical', binding: true },
        { label: '5-hour limit', usedPercent: 104, severity: 'critical', binding: false },
      ],
    }
    expect(peakUsed([spent])).toBe(100)
  })

  it('is undefined rather than zero when nothing has been read', () => {
    expect(peakUsed([])).toBeUndefined()
    expect(peakUsed([{ provider: 'codex', status: 'unavailable', fetchedAt: 1, windows: [] }])).toBeUndefined()
  })
})

describe('providerPeak', () => {
  it('takes the fullest window, full ones included, since that one stops work', () => {
    expect(providerPeak(claude)?.usedPercent).toBe(74)
    expect(providerPeak({ ...claude, windows: [...claude.windows, { label: '5-hour limit', usedPercent: 100 }] })?.usedPercent).toBe(100)
  })

  it('is undefined for a provider that did not answer or reported nothing', () => {
    expect(providerPeak({ provider: 'grok', status: 'unavailable', fetchedAt: 1, windows: [] })).toBeUndefined()
    expect(providerPeak({ ...codex, windows: [] })).toBeUndefined()
  })
})

describe('displayPercent', () => {
  it('shows real sub-one usage without scaling the provider number', () => {
    expect(displayPercent(0)).toBe(0)
    expect(displayPercent(0.4285714285714286)).toBe(1)
    expect(displayPercent(1.678)).toBe(2)
  })
})

describe('heatOf', () => {
  it('takes the provider at its word over any threshold of ours', () => {
    // 96% would be critical on the fallback ladder. Claude says it is fine, and
    // Claude is the one that knows what this account is allowed to do.
    expect(heatOf({ label: 'x', usedPercent: 96, severity: 'normal' })).toBe('normal')
    expect(heatOf({ label: 'x', usedPercent: 3, severity: 'critical' })).toBe('critical')
  })

  it('falls back to a threshold where a provider reports no severity', () => {
    expect(heatOf({ label: 'x', usedPercent: 79 })).toBe('normal')
    expect(heatOf({ label: 'x', usedPercent: 80 })).toBe('warn')
    expect(heatOf({ label: 'x', usedPercent: 95 })).toBe('critical')
  })
})

describe('resetLabel', () => {
  const now = Date.parse('2026-08-13T12:00:00Z')

  it('counts down while that is the useful thing to say', () => {
    expect(resetLabel(now + 42 * 60_000, now)).toBe('resets in 42m')
    expect(resetLabel(now + 85 * 60_000, now)).toBe('resets in 1h 25m')
    expect(resetLabel(now + 120 * 60_000, now)).toBe('resets in 2h')
  })

  it('names the day once a countdown stops being arithmetic anyone wants to do', () => {
    const label = resetLabel(now + 58 * 60 * 60_000, now)
    expect(label.startsWith('resets ')).toBe(true)
    expect(label).not.toContain('resets in')
  })

  it('says nothing at all when the provider gave no reset moment', () => {
    expect(resetLabel(undefined, now)).toBe('')
  })

  it('does not count backwards past the reset', () => {
    expect(resetLabel(now - 60_000, now)).toBe('resetting')
  })
})

describe('byCardOrder', () => {
  it('puts the multi-window providers first regardless of probe order', () => {
    const grok: ProviderUsage = { provider: 'grok', status: 'ok', fetchedAt: 1_000, windows: [] }
    const cursor: ProviderUsage = { provider: 'cursor', status: 'ok', fetchedAt: 1_000, windows: [] }
    const sorted = [codex, grok, cursor, claude].sort(byCardOrder).map((usage) => usage.provider)
    expect(sorted).toEqual(['claude', 'cursor', 'grok', 'codex'])
  })
})

describe('subscriptionGraph', () => {
  const minute = 60_000
  const sampleUsage = (): ProviderUsage => ({
    provider: 'codex', status: 'ok', fetchedAt: 60 * minute,
    windows: [{ label: '5-hour limit', minutes: 300, resetsAt: 300 * minute, usedPercent: 30,
      history: [{ at: 30 * minute, usedPercent: 10 }, { at: 45 * minute, usedPercent: 20 }, { at: 60 * minute, usedPercent: 30 }],
    }],
  })
  const graph = (usage = sampleUsage(), now = usage.fetchedAt) => subscriptionGraph(usage, usage.windows[0]!, now)

  it('uses observed growth, keeps the 100% limit and exposes uncapped estimated overflow', () => {
    const result = graph()
    expect(result.startsAt).toBe(0)
    expect(result.limitPercent).toBe(100)
    expect(result.points[0]).toEqual({ at: 30 * minute, usedPercent: 10 })
    expect(result.projection).toEqual({
      method: 'observed-rate', from: { at: 60 * minute, usedPercent: 30 },
      to: { at: 300 * minute, usedPercent: 190 }, reachesLimitAt: 165 * minute,
    })
  })

  it('refuses missing or sparse history, expired readings, unknown periods and decreasing usage', () => {
    const cases = [
      ['history-unavailable', (usage: ProviderUsage) => { delete usage.windows[0]!.history }],
      ['insufficient-history', (usage: ProviderUsage) => { usage.windows[0]!.history!.splice(0, 2) }],
      ['unknown-period', (usage: ProviderUsage) => { delete usage.windows[0]!.resetsAt }],
      ['unknown-period', (usage: ProviderUsage) => { delete usage.windows[0]!.minutes }],
      ['unavailable', (usage: ProviderUsage) => { usage.status = 'unavailable' }],
      ['usage-decreased', (usage: ProviderUsage) => { usage.windows[0]!.history![1]!.usedPercent = 35 }],
    ] as const
    for (const [reason, change] of cases) {
      const usage = sampleUsage()
      change(usage)
      expect(graph(usage).projectionUnavailableReason).toBe(reason)
      expect(graph(usage).projection).toBeNull()
    }
    expect(graph(sampleUsage(), 90 * minute).projectionUnavailableReason).toBe('stale')
    expect(graph(sampleUsage(), 300 * minute).projectionUnavailableReason).toBe('reset-pending')
  })

  it('keeps offline gaps visible while using the observed cumulative change for pacing', () => {
    const usage = sampleUsage()
    usage.windows[0]!.history![0]!.at = 0
    const result = graph(usage)
    expect(result.segments.map((segment) => segment.length)).toEqual([1, 2])
    expect(result.projection?.to.usedPercent).toBe(110)
  })

  it('uses exact provider period boundaries and excludes points outside them', () => {
    const usage = sampleUsage()
    usage.windows[0]!.startsAt = 10 * minute + 123
    usage.windows[0]!.history!.unshift({ at: 0, usedPercent: 0 })
    usage.windows[0]!.history!.push({ at: 300 * minute, usedPercent: 1 })
    const result = graph(usage)
    expect(result.startsAt).toBe(10 * minute + 123)
    expect(result.points).toHaveLength(3)
    expect(result.points[0]?.at).toBe(30 * minute)
  })

  it('does not infer weekly pacing from a short burst and supports a measured flat rate', () => {
    const weekly = sampleUsage()
    weekly.windows[0]!.minutes = 10080
    weekly.windows[0]!.resetsAt = 10080 * minute
    expect(graph(weekly).projectionUnavailableReason).toBe('insufficient-history')
    const flat = sampleUsage()
    flat.windows[0]!.history!.forEach((point) => { point.usedPercent = 30 })
    expect(graph(flat).projection?.to.usedPercent).toBe(30)
    expect(graph(flat).projection?.reachesLimitAt).toBeNull()
  })
})

describe('limit pace', () => {
  const hour = 3_600_000
  // A 5-hour window that opened two hours ago: 40% of it has elapsed.
  const at = (usedPercent: number) => ({ label: '5-hour limit', usedPercent, resetsAt: 3 * hour, minutes: 300 })

  it('measures elapsed time from the start, or from reset minus length', () => {
    expect(elapsedShare(at(0), 0)).toBeCloseTo(0.4)
    expect(elapsedShare({ ...at(0), startsAt: -hour, minutes: undefined }, 0)).toBeCloseTo(0.25)
    expect(elapsedShare({ label: 'x', usedPercent: 0, minutes: 300 }, 0)).toBeNull()
  })

  it('reads ahead, on and under pace with five points of slack', () => {
    expect(paceOf(at(46), 0)).toBe('ahead')
    expect(paceOf(at(44), 0)).toBe('on')
    expect(paceOf(at(30), 0)).toBe('under')
  })

  it('shows what is left and when it resets', () => {
    expect(remainingPercent(at(62.4))).toBe(38)
    expect(remainingPercent(at(130))).toBe(0)
    expect(resetsIn(at(0), 0)).toBe('resets in 3h 0m')
    expect(resetsIn(at(0), 4 * hour)).toBe('resets now')
    expect(formatDuration(3 * 24 * hour + 4 * hour + 59_000)).toBe('3d 4h')
    expect(formatDuration(12 * 60_000)).toBe('12m')
  })
})
