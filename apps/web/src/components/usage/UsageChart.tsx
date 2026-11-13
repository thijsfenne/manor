import { useMemo, useState, type KeyboardEvent } from 'react'
import type { UsageReportProvider } from '@manor/contracts'
import { formatDayShort, formatTokens, formatUsd } from './usageFormat'
import { PROVIDER_PRESENTATION } from './usageProviders'
import type { DayTotals } from './usageSummary'

/**
 * The daily chart: one bar per day, stacked by provider. A day is a total, not a
 * point on a curve, so a bar says what happened that day and nothing about the days
 * around it. Pointing at a bar, or stepping to it with the arrow keys, reads that
 * day out per provider.
 */

export type ChartMetric = 'cost' | 'tokens'

/** How many lines the scale draws above zero at most. */
const SCALE_LINES = 4
/** Round steps a scale may count in, per power of ten. */
const ROUND_STEPS = [1, 2, 2.5, 5, 10]

/**
 * The lines of a scale that holds `peak`: a round step, as few lines as fit, and a
 * top line at or above the tallest bar so that bar is never cut off.
 */
export function scaleLines(peak: number): number[] {
  if (!(peak > 0)) return [0]
  const power = 10 ** Math.floor(Math.log10(peak / SCALE_LINES))
  const step = power * (ROUND_STEPS.find((round) => round * power * SCALE_LINES >= peak) ?? 10)
  const lines: number[] = []
  for (let line = 0; line < SCALE_LINES + 1; line += 1) {
    lines.push(line * step)
    if (line * step >= peak) break
  }
  return lines
}

interface Segment {
  provider: UsageReportProvider
  value: number
  /** A cost nobody could price. Tokens are always a real count. */
  unpriced: boolean
}

interface Bar {
  day: string
  segments: Segment[]
  total: number
  unpriced: boolean
}

export function UsageChart({
  providers,
  days,
  daily,
  metric,
}: {
  providers: readonly UsageReportProvider[]
  days: readonly string[]
  daily: ReadonlyMap<string, DayTotals>
  metric: ChartMetric
}) {
  const [active, setActive] = useState<number | null>(null)
  const format = metric === 'tokens' ? formatTokens : formatUsd

  const { bars, lines, top } = useMemo(() => {
    const bars = days.map((day): Bar => {
      const totals = daily.get(day)
      const segments = providers.map((provider): Segment => {
        const entry = totals?.byProvider.get(provider)
        return {
          provider,
          value: entry === undefined ? 0 : metric === 'tokens' ? entry.totalTokens : entry.costUsd,
          unpriced: metric === 'cost' && entry?.costUnknown === true,
        }
      })
      return {
        day,
        segments,
        total: segments.reduce((sum, segment) => sum + segment.value, 0),
        unpriced: metric === 'cost' && totals?.costUnknown === true,
      }
    })
    const lines = scaleLines(Math.max(0, ...bars.map((bar) => bar.total)))
    return { bars, lines, top: lines.at(-1) ?? 0 }
  }, [daily, days, metric, providers])

  const share = (value: number) => (top === 0 ? 0 : (value / top) * 100)
  const last = bars.length - 1

  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    if (last < 0) return
    const moves: Record<string, number | null> = {
      ArrowLeft: Math.max(0, (active ?? last + 1) - 1),
      ArrowRight: Math.min(last, (active ?? -1) + 1),
      Home: 0,
      End: last,
      Escape: null,
    }
    if (!(event.key in moves)) return
    event.preventDefault()
    setActive(moves[event.key] ?? null)
  }

  const shown = active === null ? undefined : bars[active]
  // The readout hangs from the side of the plot the bar is not on, so it never covers it.
  const readoutSide = active !== null && active > last / 2 ? 'left-0' : 'right-0'
  const what = metric === 'tokens' ? 'processed tokens' : 'cost'
  const middle = days[Math.floor(days.length / 2)]

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-56 w-14 flex-none" aria-hidden>
          {lines.map((line) => (
            <span
              key={line}
              className="absolute right-0 translate-y-1/2 text-meta text-dim tabular-nums"
              style={{ bottom: `${String(share(line))}%` }}
            >
              {line === 0 ? '0' : format(line)}
            </span>
          ))}
        </div>
        <div
          role="group"
          aria-label={`Daily ${what} by provider. Arrow keys read one day at a time.`}
          tabIndex={0}
          className="relative h-56 min-w-0 flex-1 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          onKeyDown={step}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          {lines.map((line) => (
            <span key={line} aria-hidden className="absolute inset-x-0 border-t border-line" style={{ bottom: `${String(share(line))}%` }} />
          ))}
          <div className="absolute inset-0 flex items-stretch" aria-hidden>
            {bars.map((bar, index) => (
              // The whole column listens, so the gap between two bars still reads a day.
              <div
                key={bar.day}
                className={`flex min-w-0 flex-1 justify-center ${active === null || active === index ? '' : 'opacity-45'}`}
                onPointerEnter={() => setActive(index)}
              >
                {/* A width of its own, not padding: a percentage padding is measured
                    against the whole plot and would squeeze a narrow bar to nothing. */}
                <div className="flex h-full w-[76%] min-w-px flex-col-reverse">
                  {bar.segments.map((segment) => segment.value <= 0 ? null : (
                    <span
                      key={segment.provider}
                      className="w-full flex-none first:rounded-b-[1px] last:rounded-t-[2px]"
                      style={{ height: `${String(share(segment.value))}%`, backgroundColor: PROVIDER_PRESENTATION[segment.provider].color }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {shown === undefined ? null : (
            <div
              aria-live="polite"
              className={`pointer-events-none absolute top-0 z-10 min-w-36 rounded-lg border border-line bg-raised px-2.5 py-2 text-meta shadow-popover ${readoutSide}`}
            >
              <div className="mb-1 text-dim">{formatDayShort(shown.day)}</div>
              {shown.segments.map(({ provider, value, unpriced }) => (
                <div key={provider} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted">
                    <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: PROVIDER_PRESENTATION[provider].color }} />
                    {PROVIDER_PRESENTATION[provider].label}
                  </span>
                  <span className="text-text tabular-nums">{unpriced ? <span className="text-dim">Unpriced</span> : format(value)}</span>
                </div>
              ))}
              {shown.segments.length < 2 ? null : (
                <div className="mt-1 flex items-center justify-between gap-3 border-t border-line pt-1">
                  <span className="text-muted">Total</span>
                  <span className="text-text tabular-nums">{shown.unpriced ? <span className="text-dim">Unpriced</span> : format(shown.total)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-16 text-meta tracking-[0.04em] text-dim uppercase" aria-hidden>
        <span>{days[0] === undefined ? '' : formatDayShort(days[0])}</span>
        <span>{middle === undefined || days.length < 3 ? '' : formatDayShort(middle)}</span>
        <span>{days.at(-1) === undefined ? '' : formatDayShort(days.at(-1)!)}</span>
      </div>
    </div>
  )
}
