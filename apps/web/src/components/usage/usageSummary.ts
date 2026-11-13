import type { UsageDay, UsageReport, UsageReportProvider } from '@manor/contracts'
import { enumerateDays } from './usageFormat'

/**
 * The report's rows added up the ways the Usage view reads them. Every row is a plain sum, so each figure here is too; nothing is
 * estimated on this side of the wire.
 */

/** Reading order for every chart, summary and table. */
export const PROVIDER_ORDER: readonly UsageReportProvider[] = ['codex', 'claude', 'grok', 'cursor', 'unknown']

export interface Totals {
  costUsd: number
  /** Input plus output, cache reads at face value: what was processed. */
  totalTokens: number
  /** Tokens ran but none of their responses could be priced, so this $0 is not a price. */
  costUnknown: boolean
}

export interface ProviderTotals extends Totals {
  provider: UsageReportProvider
  costShare: number
  tokenShare: number
}

export interface ModelTotals extends Totals {
  provider: UsageReportProvider
  model: string | null
  costShare: number
  tokenShare: number
}

export interface DayTotals extends Totals {
  day: string
  costShare: number
  byProvider: ReadonlyMap<UsageReportProvider, Totals>
}

export interface UsageSummary extends Totals {
  /** Every day of the window, oldest first, including empty ones. */
  days: string[]
  responses: number
  sessions: number
  inputTokens: number
  outputTokens: number
  observedInputTokens: number
  cachedInputTokens: number
  uncachedInputTokens: number
  cacheWriteTokens: number
  providers: ProviderTotals[]
  /** Heaviest cost first, then tokens. */
  models: ModelTotals[]
  daily: ReadonlyMap<string, DayTotals>
  costQuality: {
    providerReportedShare: number
    modelPricedShare: number
    unpricedShare: number
    cacheSavingsUsd: number
  }
}

const tokensOf = (row: UsageDay) => row.inputTokens + row.outputTokens
const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole)

/** A running sum that remembers whether any response in it carried a price. */
class Tally {
  costUsd = 0
  totalTokens = 0
  private priced = 0
  add(row: UsageDay) {
    this.costUsd += row.costUsd
    this.totalTokens += tokensOf(row)
    this.priced += row.providerReportedResponses + row.modelPricedResponses
  }
  totals(): Totals {
    return { costUsd: this.costUsd, totalTokens: this.totalTokens, costUnknown: this.priced === 0 && this.totalTokens > 0 }
  }
}

const tallyIn = <K>(map: Map<K, Tally>, key: K) => {
  const found = map.get(key)
  if (found !== undefined) return found
  const fresh = new Tally()
  map.set(key, fresh)
  return fresh
}

export function summarizeUsage(report: UsageReport): UsageSummary {
  const sum = (pick: (row: UsageDay) => number) => report.rows.reduce((total, row) => total + pick(row), 0)
  const responses = sum((row) => row.responses)

  const all = new Tally()
  const byProvider = new Map<UsageReportProvider, Tally>()
  const byModel = new Map<string, { provider: UsageReportProvider; model: string | null; tally: Tally }>()
  const byDay = new Map<string, { all: Tally; byProvider: Map<UsageReportProvider, Tally> }>()
  for (const row of report.rows) {
    all.add(row)
    tallyIn(byProvider, row.provider).add(row)
    const key = JSON.stringify([row.provider, row.model])
    const model = byModel.get(key) ?? { provider: row.provider, model: row.model, tally: new Tally() }
    model.tally.add(row)
    byModel.set(key, model)
    const day = byDay.get(row.day) ?? { all: new Tally(), byProvider: new Map<UsageReportProvider, Tally>() }
    day.all.add(row)
    tallyIn(day.byProvider, row.provider).add(row)
    byDay.set(row.day, day)
  }
  const total = all.totals()

  return {
    days: enumerateDays(report.since, report.until),
    ...total,
    responses,
    sessions: report.sessions,
    inputTokens: sum((row) => row.inputTokens),
    outputTokens: sum((row) => row.outputTokens),
    observedInputTokens: sum((row) => row.observedInputTokens),
    cachedInputTokens: sum((row) => row.cachedInputTokens),
    uncachedInputTokens: sum((row) => row.uncachedInputTokens),
    cacheWriteTokens: sum((row) => row.cacheWriteTokens),
    providers: PROVIDER_ORDER.flatMap((provider) => {
      const totals = byProvider.get(provider)?.totals()
      return totals === undefined || (totals.totalTokens === 0 && totals.costUsd === 0)
        ? []
        : [{
            provider,
            ...totals,
            costShare: share(totals.costUsd, total.costUsd),
            tokenShare: share(totals.totalTokens, total.totalTokens),
          }]
    }),
    models: [...byModel.values()]
      .map(({ provider, model, tally }) => {
        const totals = tally.totals()
        return {
          provider,
          model,
          ...totals,
          costShare: share(totals.costUsd, total.costUsd),
          tokenShare: share(totals.totalTokens, total.totalTokens),
        }
      })
      .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
    daily: new Map(
      [...byDay].map(([day, tallies]) => {
        const totals = tallies.all.totals()
        return [day, {
          day,
          ...totals,
          costShare: share(totals.costUsd, total.costUsd),
          byProvider: new Map([...tallies.byProvider].map(([provider, tally]) => [provider, tally.totals()])),
        }]
      }),
    ),
    costQuality: {
      providerReportedShare: share(sum((row) => row.providerReportedResponses), responses),
      modelPricedShare: share(sum((row) => row.modelPricedResponses), responses),
      unpricedShare: share(sum((row) => row.unpricedResponses), responses),
      cacheSavingsUsd: sum((row) => row.cacheSavingsUsd),
    },
  }
}
