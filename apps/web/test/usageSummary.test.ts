import type { UsageDay, UsageReport } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { formatPercent, formatTokens, formatUsd } from '../src/components/usage/usageFormat'
import { DEFAULT_USAGE_PREFERENCES, readUsagePreferences } from '../src/components/usage/usagePreferences'
import { summarizeUsage } from '../src/components/usage/usageSummary'

const row = (patch: Partial<UsageDay>): UsageDay => ({
  day: '2026-10-01',
  provider: 'claude',
  model: 'claude-opus-5-5',
  responses: 1,
  inputTokens: 0,
  outputTokens: 0,
  observedInputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  uncachedInputTokens: 0,
  costUsd: 0,
  providerReportedResponses: 0,
  modelPricedResponses: 0,
  unpricedResponses: 0,
  unpricedTokens: 0,
  cacheSavingsUsd: 0,
  ...patch,
})

const report = (rows: UsageDay[]): UsageReport => ({
  windowDays: 7,
  timeZone: 'UTC',
  since: '2026-09-29',
  until: '2026-10-01',
  rows,
  sessions: 2,
  prices: 'current',
})

describe('summarizeUsage', () => {
  const summary = summarizeUsage(report([
    row({ day: '2026-09-29', inputTokens: 600, outputTokens: 200, costUsd: 3, providerReportedResponses: 1, cacheSavingsUsd: 2 }),
    row({ day: '2026-10-01', inputTokens: 100, outputTokens: 100, costUsd: 3, providerReportedResponses: 1 }),
    row({ day: '2026-10-01', provider: 'codex', model: 'gpt-5.6-sol', responses: 2, inputTokens: 900, outputTokens: 100, costUsd: 4, modelPricedResponses: 2 }),
    row({ day: '2026-10-01', provider: 'codex', model: 'gpt-mystery', inputTokens: 50, outputTokens: 50, unpricedResponses: 1, unpricedTokens: 100 }),
  ]))

  it('adds rows into totals and lists every day of the window, empty ones included', () => {
    expect(summary.costUsd).toBe(10)
    expect(summary.totalTokens).toBe(2100)
    expect(summary.responses).toBe(5)
    expect(summary.days).toEqual(['2026-09-29', '2026-09-30', '2026-10-01'])
    expect(summary.daily.get('2026-09-30')).toBeUndefined()
    expect(summary.daily.get('2026-10-01')?.byProvider.get('codex')).toEqual({ costUsd: 4, totalTokens: 1100, costUnknown: false })
  })

  it('splits per provider in reading order, with cost and token shares', () => {
    expect(summary.providers.map((entry) => [entry.provider, entry.costShare, entry.tokenShare, entry.costUnknown])).toEqual([
      ['codex', 0.4, 1100 / 2100, false],
      ['claude', 0.6, 1000 / 2100, false],
    ])
    const unpriced = summarizeUsage(report([row({ provider: 'codex', inputTokens: 10, unpricedResponses: 1 })]))
    expect(unpriced.providers[0]?.costUnknown).toBe(true)
  })

  it('ranks models by cost and flags one with no priced response', () => {
    expect(summary.models.map((model) => [model.model, model.costUsd, model.costUnknown])).toEqual([
      ['claude-opus-5-5', 6, false],
      ['gpt-5.6-sol', 4, false],
      ['gpt-mystery', 0, true],
    ])
  })

  it('marks every total with no priced response as unknown, but leaves an empty one at a real zero', () => {
    const unpriced = summarizeUsage(report([row({ provider: 'codex', inputTokens: 10, unpricedResponses: 1 })]))
    expect(unpriced.costUnknown).toBe(true)
    expect(unpriced.daily.get('2026-10-01')?.costUnknown).toBe(true)
    expect(unpriced.daily.get('2026-10-01')?.byProvider.get('codex')?.costUnknown).toBe(true)
    // One priced response makes the sum a real, if partial, price.
    expect(summary.daily.get('2026-10-01')?.costUnknown).toBe(false)
    expect(summarizeUsage(report([])).costUnknown).toBe(false)
  })

  it('states cost quality as shares of responses', () => {
    expect(summary.costQuality).toEqual({ providerReportedShare: 0.4, modelPricedShare: 0.4, unpricedShare: 0.2, cacheSavingsUsd: 2 })
  })

  it('reads an empty window as zeroes rather than dividing by nothing', () => {
    const empty = summarizeUsage(report([]))
    expect(empty.providers).toEqual([])
    expect(empty.costQuality.unpricedShare).toBe(0)
  })
})

describe('usage formatting', () => {
  it('keeps three significant figures with a unit', () => {
    expect(formatTokens(19_940_000_000)).toBe('19.9B')
    expect(formatTokens(804_200)).toBe('804K')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(950)).toBe('950')
  })

  it('keeps a sub-cent amount visible instead of rounding it to $0.00', () => {
    expect(formatUsd(0.0012)).toBe('$0.0012')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(10_630.99)).toBe('$10,630.99')
  })

  it('never rounds a real share down to zero', () => {
    expect(formatPercent(0.0004)).toBe('<0.1%')
    expect(formatPercent(0)).toBe('0.0%')
  })
})

describe('usage preferences', () => {
  it('opens on Limits the first time and ignores values it does not know', () => {
    expect(readUsagePreferences({ getItem: () => null })).toEqual(DEFAULT_USAGE_PREFERENCES)
    expect(DEFAULT_USAGE_PREFERENCES.tab).toBe('limits')
    expect(readUsagePreferences({ getItem: () => '{"tab":"cost","windowDays":12}' })).toEqual({ tab: 'cost', windowDays: 30 })
  })
})
