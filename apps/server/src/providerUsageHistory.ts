import type { DatabaseSync } from 'node:sqlite'
import { ProviderUsageSchema, type ProviderUsage, type UsageSample, type UsageWindow } from '@manor/contracts'
import { SqliteRecords } from './stores/sqliteDatabase.js'

const SAMPLE_INTERVAL_MS = 15 * 60_000
const MAX_SAMPLES = 4096

/** Current reset periods only. The existing records table needs no schema migration. */
export class ProviderUsageHistory {
  private readonly records

  constructor(db?: DatabaseSync) {
    this.records = db === undefined
      ? new Map<string, ProviderUsage>()
      : new SqliteRecords<ProviderUsage>(db, 'providerUsageHistory')
  }

  record(usage: ProviderUsage): ProviderUsage {
    if (usage.status !== 'ok') return usage
    const parsed = ProviderUsageSchema.safeParse(this.records.get(usage.provider))
    const previous = parsed.success && parsed.data.plan === usage.plan ? parsed.data : undefined
    const windows = usage.windows.map((window) => {
      const matching = previous?.windows.filter((old) => samePeriod(old, window)) ?? []
      const unique = usage.windows.filter((other) => other.label === window.label).length === 1
      const history = unique && matching.length === 1 ? matching[0]?.history ?? [] : []
      return { ...window, history: unique ? appendSample(history, window, usage.fetchedAt) : [] }
    })
    const saved = { ...usage, windows }
    // Invalid numbers serialize to null in SQLite and would make the next read
    // reject the entire stored document, including its valid historical samples.
    if (Number.isFinite(usage.fetchedAt)
      && windows.every((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0)) {
      this.records.set(usage.provider, saved)
    }
    return saved
  }
}

function samePeriod(a: UsageWindow, b: UsageWindow): boolean {
  return a.label === b.label && a.resetsAt === b.resetsAt && a.resetsAt !== undefined
    && a.startsAt === b.startsAt && a.minutes === b.minutes
}

function appendSample(history: UsageSample[], window: UsageWindow, at: number): UsageSample[] {
  const end = window.resetsAt
  const start = window.startsAt ?? (end !== undefined && window.minutes !== undefined && window.minutes > 0
    ? end - window.minutes * 60_000 : undefined)
  if (end === undefined || !Number.isFinite(end)
    || (start !== undefined && !Number.isFinite(start))) return []

  const previous = history.filter((sample) => sample.at < end
    && (start === undefined || sample.at >= start))
  // The provider may keep reporting the old reset while it rolls over. Refuse
  // that observation without deleting the measurements from the same period.
  if (!Number.isFinite(at) || at >= end || (start !== undefined && at < start)
    || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) return previous

  const samples = previous.filter((sample) => sample.at < at)
  const last = samples.at(-1)
  // Keep the first observation and the latest actual reading in each quarter hour.
  // No averaging, interpolation, or synthetic period-start point.
  if (samples.length > 1 && last !== undefined
    && Math.floor(last.at / SAMPLE_INTERVAL_MS) === Math.floor(at / SAMPLE_INTERVAL_MS)) samples.pop()
  samples.push({ at, usedPercent: window.usedPercent })
  return samples.slice(-MAX_SAMPLES)
}
