import { useId, useState } from 'react'
import type { UsageReport, UsageReportProvider } from '@manor/contracts'
import { SegmentedControl } from '../ui/SegmentedControl'
import { UsageChart, type ChartMetric } from './UsageChart'
import { formatCount, formatDayShort, formatPercent, formatTokens, formatUsd } from './usageFormat'
import { PROVIDER_PRESENTATION } from './usageProviders'
import type { Totals, UsageSummary } from './usageSummary'

/**
 * What Manor's own turns processed in the window and what that would cost at API
 * rates: the raw cost and its split per provider,
 * the daily chart beside it, five totals in one strip, then the breakdown and how
 * much of the cost is a real price.
 */

type Breakdown = 'model' | 'day'

const metricOptions = (id: string) =>
  [
    { value: 'tokens', label: 'Tokens', tabId: `${id}-chart-tokens`, panelId: `${id}-chart` },
    { value: 'cost', label: 'Cost', tabId: `${id}-chart-cost`, panelId: `${id}-chart` },
  ] as const

const breakdownOptions = (id: string) =>
  [
    { value: 'model', label: 'Model', tabId: `${id}-breakdown-model`, panelId: `${id}-breakdown` },
    { value: 'day', label: 'Day', tabId: `${id}-breakdown-day`, panelId: `${id}-breakdown` },
  ] as const

const PRICES_NOTE: Record<UsageReport['prices'], string | null> = {
  current: null,
  stale: 'Model prices are from an earlier copy; the last refresh failed.',
  unavailable: 'Model prices could not be loaded, so only provider-reported cost is counted.',
}

/** A cost nobody could price says so; a bare $0.00 would read as free. */
const Cost = ({ totals }: { totals: Totals }) =>
  totals.costUnknown ? <span className="text-dim">Unpriced</span> : <>{formatUsd(totals.costUsd)}</>

const Dot = ({ provider }: { provider: UsageReportProvider }) => (
  <span aria-hidden className="size-2 flex-none rounded-full" style={{ backgroundColor: PROVIDER_PRESENTATION[provider].color }} />
)

export function UsageCost({ summary, prices }: { summary: UsageSummary; prices: UsageReport['prices'] }) {
  const id = useId()
  const [metric, setMetric] = useState<ChartMetric>('cost')
  const [breakdown, setBreakdown] = useState<Breakdown>('model')
  const providers = summary.providers.map((entry) => entry.provider)
  const dailyAverage = summary.days.length === 0 ? 0 : summary.totalTokens / summary.days.length
  const pricesNote = PRICES_NOTE[prices]

  return (
    <div className="flex flex-col gap-10">
      <section className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col">
            <h2 className="m-0 text-meta font-medium text-muted">API-rate equivalent</h2>
            <p className="m-0 mt-1.5 text-[36px] leading-none font-semibold tracking-[-0.01em] text-text tabular-nums">
              <Cost totals={summary} />
            </p>
            <p className="m-0 mt-2.5 text-label text-muted">Not what you were billed.</p>
          </div>
          {summary.providers.length === 0 ? (
            <p className="m-0 text-label text-dim">No activity in this window.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-5 p-0">
              {summary.providers.map((entry) => (
                <li key={entry.provider} className="flex flex-col">
                  <div className="flex items-baseline justify-between gap-4 text-[14px]">
                    <span className="flex min-w-0 items-center gap-2 text-text">
                      <Dot provider={entry.provider} />
                      <span className="truncate">{PROVIDER_PRESENTATION[entry.provider].label}</span>
                    </span>
                    <span className={`flex-none tabular-nums ${entry.costUnknown ? '' : 'font-medium text-text'}`}>
                      <Cost totals={entry} />
                    </span>
                  </div>
                  <span aria-hidden className="mt-2 block h-[3px] overflow-hidden rounded-full bg-user-bg">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${String(entry.costShare * 100)}%`, backgroundColor: PROVIDER_PRESENTATION[entry.provider].color }}
                    />
                  </span>
                  <span className="mt-1.5 text-meta text-dim tabular-nums">
                    {entry.costUnknown
                      ? `${formatTokens(entry.totalTokens)} tokens, none priced`
                      : summary.providers.filter((other) => !other.costUnknown).length === 1
                        ? `${formatTokens(entry.totalTokens)} tokens`
                        : `${formatPercent(entry.costShare)} of cost, ${formatTokens(entry.totalTokens)} tokens`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 className="m-0 text-[14px] font-medium text-text">Daily {metric === 'tokens' ? 'processed tokens' : 'cost'}</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <SegmentedControl label="Chart metric" options={metricOptions(id)} value={metric} onChange={setMetric} />
              {providers.map((provider) => (
                <span key={provider} className="flex items-center gap-1.5 text-label text-muted">
                  <Dot provider={provider} />
                  {PROVIDER_PRESENTATION[provider].label}
                </span>
              ))}
            </div>
          </div>
          <div id={`${id}-chart`} role="tabpanel" aria-labelledby={`${id}-chart-${metric}`}>
            <UsageChart providers={providers} days={summary.days} daily={summary.daily} metric={metric} />
          </div>
        </div>
      </section>

      <section aria-label="Totals" className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-panel bg-surface-2 px-4 py-4 md:grid-cols-5">
        <Stat label="Processed tokens" value={formatTokens(summary.totalTokens)} detail={`${formatTokens(dailyAverage)} daily average`} />
        <Stat
          label="Cached input"
          value={formatTokens(summary.cachedInputTokens)}
          detail={`${formatPercent(summary.observedInputTokens === 0 ? 0 : summary.cachedInputTokens / summary.observedInputTokens)} of observed input`}
        />
        <Stat label="Uncached input" value={formatTokens(summary.uncachedInputTokens)} detail={`${formatTokens(summary.cacheWriteTokens)} cache writes`} />
        <Stat label="Output" value={formatTokens(summary.outputTokens)} detail="includes reasoning" />
        <Stat
          label="Responses"
          value={formatCount(summary.responses)}
          detail={`${formatCount(summary.sessions)} ${summary.sessions === 1 ? 'session' : 'sessions'}`}
        />
      </section>

      <section className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-[14px] font-medium text-text">Breakdown</h2>
            <SegmentedControl label="Breakdown" options={breakdownOptions(id)} value={breakdown} onChange={setBreakdown} />
          </div>
          <div id={`${id}-breakdown`} role="tabpanel" aria-labelledby={`${id}-breakdown-${breakdown}`}>
            {breakdown === 'model' ? <ModelTable summary={summary} /> : <DayTable summary={summary} />}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {/* Aligned with Breakdown's heading row, whose control is 28px tall. */}
          <h2 className="m-0 flex h-7 items-center text-[14px] font-medium text-text">Cost quality</h2>
          <dl className="m-0">
            <Quality label="Provider reported" value={formatPercent(summary.costQuality.providerReportedShare)} />
            <Quality label="Model priced" value={formatPercent(summary.costQuality.modelPricedShare)} />
            <Quality label="Unpriced" value={formatPercent(summary.costQuality.unpricedShare)} />
            <Quality
              label="Cache savings"
              value={<Cost totals={{ ...summary, costUsd: summary.costQuality.cacheSavingsUsd }} />}
            />
          </dl>
          <p className="m-0 text-meta leading-relaxed text-dim">
            Shares of responses. Provider reported is the CLI's own price; model priced uses list rates. Unpriced
            responses add nothing to the cost above.
            {pricesNote === null ? null : ` ${pricesNote}`}
          </p>
        </div>
      </section>
    </div>
  )
}

const Stat = ({ label, value, detail }: { label: string; value: string; detail: string }) => (
  <div className="flex min-w-0 flex-col">
    <span className="text-label text-muted">{label}</span>
    <span className="mt-1 text-[20px] leading-tight text-text tabular-nums">{value}</span>
    <span className="mt-1 truncate text-meta text-dim">{detail}</span>
  </div>
)

const Quality = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 text-[14px]">
    <dt className="text-muted">{label}</dt>
    <dd className="m-0 text-text tabular-nums">{value}</dd>
  </div>
)

const Th = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <th className={`border-b border-line py-2 text-label font-normal text-dim ${className}`}>{children}</th>
)

const Td = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <td className={`border-b border-line py-2.5 tabular-nums ${className}`}>{children}</td>
)

const Empty = ({ columns }: { columns: number }) => (
  <tr>
    <td colSpan={columns} className="py-6 text-center text-label text-dim">No activity in this window.</td>
  </tr>
)

function ModelTable({ summary }: { summary: UsageSummary }) {
  return (
    <table className="w-full border-collapse text-[14px]">
      <thead>
        <tr>
          <Th className="text-left">Model</Th>
          <Th className="pl-6 text-right">Cost</Th>
          <Th className="hidden pl-6 text-right sm:table-cell">Share</Th>
          <Th className="pl-6 text-right">Tokens</Th>
        </tr>
      </thead>
      <tbody>
        {summary.models.length === 0 ? (
          <Empty columns={4} />
        ) : (
          summary.models.map((model) => (
            <tr key={`${model.provider}:${model.model ?? ''}`}>
              <Td className="text-left">
                <span className="flex min-w-0 items-center gap-2">
                  <Dot provider={model.provider} />
                  {model.model === null ? (
                    <span className="text-dim">Model not reported</span>
                  ) : (
                    <span className="truncate text-text">{model.model}</span>
                  )}
                </span>
              </Td>
              <Td className="pl-6 text-right whitespace-nowrap text-text">
                <Cost totals={model} />
              </Td>
              <Td className="hidden pl-6 text-right text-muted sm:table-cell">
                {model.costUnknown ? '' : formatPercent(model.costShare)}
              </Td>
              <Td className="pl-6 text-right text-muted">{formatTokens(model.totalTokens)}</Td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}

function DayTable({ summary }: { summary: UsageSummary }) {
  const providers = summary.providers.map((entry) => entry.provider)
  // Newest first, and only days with something in them: a 90-day window of mostly
  // empty rows would push the busy days off the page.
  const days = [...summary.days].reverse().flatMap((day) => {
    const totals = summary.daily.get(day)
    return totals === undefined || totals.totalTokens === 0 ? [] : [totals]
  })
  return (
    <table className="w-full border-collapse text-[14px]">
      <thead>
        <tr>
          <Th className="text-left">Day</Th>
          {providers.map((provider) => (
            <Th key={provider} className="pl-6 text-right">{PROVIDER_PRESENTATION[provider].label}</Th>
          ))}
          <Th className="pl-6 text-right">Total</Th>
          <Th className="hidden pl-6 text-right sm:table-cell">Share</Th>
          <Th className="pl-6 text-right">Tokens</Th>
        </tr>
      </thead>
      <tbody>
        {days.length === 0 ? (
          <Empty columns={providers.length + 4} />
        ) : (
          days.map((day) => (
            <tr key={day.day}>
              <Td className="text-left text-text">{formatDayShort(day.day)}</Td>
              {providers.map((provider) => (
                <Td key={provider} className="pl-6 text-right text-muted">
                  {/* A provider that did not run that day cost nothing, which $0.00 says truthfully. */}
                  <Cost totals={day.byProvider.get(provider) ?? { costUsd: 0, totalTokens: 0, costUnknown: false }} />
                </Td>
              ))}
              <Td className="pl-6 text-right text-text"><Cost totals={day} /></Td>
              <Td className="hidden pl-6 text-right text-muted sm:table-cell">{day.costUnknown ? '' : formatPercent(day.costShare)}</Td>
              <Td className="pl-6 text-right text-muted">{formatTokens(day.totalTokens)}</Td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}
