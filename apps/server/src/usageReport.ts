import {
  driverForModel,
  type DriverName,
  type ThreadEvent,
  type UsageDay,
  type UsageReport,
  type UsageReportProvider,
  type UsageWindowDays,
} from '@manor/contracts'
import { priceRun } from './usagePricing.js'
import type { RateSnapshot } from './usageRates.js'

/**
 * The Usage view's aggregate: one row per day, provider and model, already priced.
 *
 * The grain underneath is the persona run (chat, turn, persona) rather than the turn.
 * A delegated turn carries the id of the turn that delegated it, and turn ids were a
 * per-chat counter before they were uuids, so keying on the turn alone merges
 * personas: on the live database it once moved 4,3M input tokens from Smith to Marlow.
 */

/** Input split by cache state, summed over a run's usage events. */
export interface UsageSplit {
  uncached: number
  cached: number
  cacheWrite: number
}

export interface UsageRun {
  chatId: string
  agentId: string
  /** The run's first usage-carrying event, so a turn lands on the day it was spent. */
  at: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  reportedModel: string | undefined
  /** The provider the turn ran on, from its turn result. Absent on turns older than that field. */
  driver?: DriverName
  /**
   * Null once any usage event of the run lacked a split, since half a split would read
   * as a smaller total. Undefined on rows stored before the split was recorded.
   */
  split?: UsageSplit | null
  /** False until a usage-carrying event lands. */
  reported: boolean
}

/**
 * Folds one transcript event into its run. Which events count is `usageFrom`'s rule:
 * usage from `turn_result` and from `agent_message`, summed rather than assigned,
 * because old transcripts carry it on the message that represented a whole turn and
 * new ones carry it on the result. Returns undefined for events that carry nothing.
 */
export function foldUsageEvent(run: UsageRun | undefined, chatId: string, event: ThreadEvent): UsageRun | undefined {
  if (event.type !== 'turn_result' && event.type !== 'agent_message') return undefined
  const usage = event.usage
  const driver = event.type === 'turn_result' ? event.driver : undefined
  const model = event.type === 'turn_result' ? event.reportedModel : undefined
  if (usage === undefined && driver === undefined && model === undefined) return undefined
  const next: UsageRun = run === undefined
    ? { chatId, agentId: event.agentId, at: event.ts, inputTokens: 0, outputTokens: 0, costUsd: null, reportedModel: undefined, reported: false }
    : { ...run, ...(run.split == null ? {} : { split: { ...run.split } }) }
  if (driver !== undefined) next.driver = driver
  if (model !== undefined) next.reportedModel = model
  if (usage === undefined) return next
  const parts = usage.breakdown === undefined
    ? null
    : {
        uncached: usage.breakdown.freshInputTokens,
        cached: usage.breakdown.cacheReadTokens,
        cacheWrite: usage.breakdown.cacheWrite5mTokens + usage.breakdown.cacheWrite1hTokens,
      }
  next.split = !next.reported
    ? parts
    : next.split == null || parts === null
      ? null
      : { uncached: next.split.uncached + parts.uncached, cached: next.split.cached + parts.cached, cacheWrite: next.split.cacheWrite + parts.cacheWrite }
  next.at = next.reported ? Math.min(next.at, event.ts) : event.ts
  next.reported = true
  next.inputTokens += usage.inputTokens
  next.outputTokens += usage.outputTokens
  if (usage.costUsd !== undefined) next.costUsd = (next.costUsd ?? 0) + usage.costUsd
  return next
}

export const usageRunKey = (chatId: string, turnId: string, agentId: string) => JSON.stringify([chatId, turnId, agentId])

/** Every run in a set of transcripts, for stores and tests that hold the events themselves. */
export function usageRunsFrom(byChat: ReadonlyMap<string, readonly ThreadEvent[]>): UsageRun[] {
  const runs = new Map<string, UsageRun>()
  for (const [chatId, events] of byChat) {
    for (const event of events) {
      if (event.type !== 'turn_result' && event.type !== 'agent_message') continue
      const key = usageRunKey(chatId, event.turnId, event.agentId)
      const run = foldUsageEvent(runs.get(key), chatId, event)
      if (run !== undefined) runs.set(key, run)
    }
  }
  return [...runs.values()]
}

/**
 * Which provider a run was spent on. The turn's own driver wins; older turns fall back
 * to the model they name, and a run with a price but neither can only be Claude, the
 * one CLI that reports a price.
 */
export function providerOf(run: Pick<UsageRun, 'driver' | 'reportedModel' | 'costUsd'>): UsageReportProvider {
  if (run.driver !== undefined && run.driver !== 'mock') return run.driver
  const model = run.reportedModel?.toLowerCase()
  if (model !== undefined) {
    const known = driverForModel(model)
    if (known !== undefined && known !== 'mock') return known
    if (model.startsWith('cursor-') || model.startsWith('composer')) return 'cursor'
    if (model.startsWith('claude')) return 'claude'
    if (model.startsWith('gpt') || /^o\d/.test(model) || model.startsWith('codex')) return 'codex'
    if (model.startsWith('grok')) return 'grok'
  }
  return run.costUsd === null ? 'unknown' : 'claude'
}

const formatters = new Map<string, Intl.DateTimeFormat>()
const dayFormatter = (timeZone: string) => {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** A zone the runtime can format in, else the server's own. */
export function usableTimeZone(timeZone: string | undefined): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  if (timeZone === undefined) return fallback
  try {
    dayFormatter(timeZone)
    return timeZone
  } catch {
    return fallback
  }
}

/** `YYYY-MM-DD` of an instant in a zone. */
export const dayOf = (at: number, timeZone: string) => dayFormatter(timeZone).format(at)

/** `2026-10-08` minus 6 days is `2026-10-02`, calendar arithmetic with no zone in it. */
export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export interface UsageReportOptions {
  windowDays: UsageWindowDays
  timeZone: string
  now: number
  rates: RateSnapshot
}

const emptyRow = (day: string, provider: UsageReportProvider, model: string | null): UsageDay => ({
  day, provider, model, responses: 0, inputTokens: 0, outputTokens: 0, observedInputTokens: 0,
  cachedInputTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 0, costUsd: 0,
  providerReportedResponses: 0, modelPricedResponses: 0, unpricedResponses: 0, unpricedTokens: 0, cacheSavingsUsd: 0,
})

export function usageReportFromRuns(records: Iterable<UsageRun>, options: UsageReportOptions): UsageReport {
  const { windowDays, timeZone, now, rates } = options
  const until = dayOf(now, timeZone)
  const since = shiftDay(until, 1 - windowDays)
  const rows = new Map<string, UsageDay>()
  const chats = new Set<string>()

  for (const run of records) {
    // A run with tool calls and no result burned real quota, but Manor has no number
    // for it, and counting it as a zero-token turn would drag every average down.
    if (!run.reported) continue
    const day = dayOf(run.at, timeZone)
    if (day < since || day > until) continue
    const provider = providerOf(run)
    const model = run.reportedModel ?? null
    const key = JSON.stringify([day, provider, model])
    const row = rows.get(key) ?? emptyRow(day, provider, model)
    const split = run.split ?? null
    const priced = priceRun(rates.table, {
      model,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      split,
      reportedCostUsd: run.costUsd,
    })
    row.responses += 1
    row.inputTokens += run.inputTokens
    row.outputTokens += run.outputTokens
    if (split !== null) {
      row.observedInputTokens += run.inputTokens
      row.cachedInputTokens += split.cached
      row.cacheWriteTokens += split.cacheWrite
      row.uncachedInputTokens += split.uncached
    }
    row.costUsd += priced.costUsd
    row.cacheSavingsUsd += priced.cacheSavingsUsd
    if (priced.source === 'providerReported') row.providerReportedResponses += 1
    else if (priced.source === 'modelPriced') row.modelPricedResponses += 1
    else {
      row.unpricedResponses += 1
      row.unpricedTokens += run.inputTokens + run.outputTokens
    }
    rows.set(key, row)
    chats.add(run.chatId)
  }

  return {
    windowDays,
    timeZone,
    since,
    until,
    rows: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day)),
    sessions: chats.size,
    prices: rates.status,
  }
}
