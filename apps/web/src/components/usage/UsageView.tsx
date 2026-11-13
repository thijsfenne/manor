import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import { RefreshIcon } from '@hugeicons/core-free-icons'
import { USAGE_WINDOW_DAYS, type ProviderUsage, type UsageReport, type UsageWindowDays } from '@manor/contracts'
import { IconButton } from '../ui/IconButton'
import { SegmentedControl } from '../ui/SegmentedControl'
import type { ConnectionStatus } from '../../useWorkspace'
import { UsageCost } from './UsageCost'
import { UsageLimits } from './UsageLimits'
import { formatDayShort } from './usageFormat'
import { usagePreferencesStore, type UsagePreferences, type UsageTab } from './usagePreferences'
import { summarizeUsage } from './usageSummary'

/**
 * The Usage page: Limits (what each subscription has left) opens by
 * default, Cost (what Manor's own turns would cost at API rates) sits beside it. The
 * two never share a number, because one is the provider's quota and the other is
 * Manor's transcript.
 */

const tabOptions = (id: string) =>
  [
    { value: 'limits', label: 'Limits', tabId: `${id}-tab-limits`, panelId: `${id}-panel` },
    { value: 'cost', label: 'Cost', tabId: `${id}-tab-cost`, panelId: `${id}-panel` },
  ] as const

const windowOptions = (id: string) =>
  USAGE_WINDOW_DAYS.map((days) => ({
    value: String(days) as `${UsageWindowDays}`,
    label: `${String(days)} days`,
    tabId: `${id}-window-${String(days)}`,
    panelId: `${id}-panel`,
  }))

/** A refresh the server never answers must not spin forever. */
const REFRESH_GIVE_UP_MS = 15_000

interface UsageViewProps {
  /** "Usage" on the stage, "Usage & limits" under Settings. */
  title: string
  report: UsageReport | null
  providerUsage: readonly ProviderUsage[]
  /**
   * Whether a request can have left at all. Without it the empty state is a lying
   * spinner: `send` drops the message while the socket is shut.
   */
  status: ConnectionStatus
  /** Asks for the report of the last N days; false when the socket was down. */
  onLoadReport: (windowDays: UsageWindowDays) => boolean
  /** Asks every provider for a fresh limits reading; false when the socket was down. */
  onRefreshLimits: () => boolean
  /** Injected for deterministic reset and pace labels in tests. */
  now?: () => number
}

export function UsageView({
  title,
  report,
  providerUsage,
  status,
  onLoadReport,
  onRefreshLimits,
  now = Date.now,
}: UsageViewProps) {
  // Ids per mount: the stage view and Settings' page can both be in the document.
  const id = useId()
  const preferences = useSyncExternalStore(usagePreferencesStore.subscribe, usagePreferencesStore.get, usagePreferencesStore.get)
  const { tab, windowDays } = preferences
  const [at, setAt] = useState(now)
  const [refreshing, setRefreshing] = useState<UsageTab | null>(null)

  // Reset countdowns and pace move with the clock; a minute is finer than either reads.
  useEffect(() => {
    const timer = setInterval(() => setAt(now()), 30_000)
    return () => clearInterval(timer)
  }, [now])

  // The cost report is asked for whenever it is shown, for the window it shows. It is
  // a snapshot and turns keep landing behind it, so the second visit asks again; the
  // previous numbers stay up meanwhile.
  useEffect(() => {
    if (tab === 'cost' && status === 'live') onLoadReport(windowDays)
  }, [tab, windowDays, status, onLoadReport])

  // Limits are the provider's reading, up to fifteen minutes old between turns, so
  // showing them asks for a fresh one. The server skips a provider read seconds ago.
  useEffect(() => {
    if (tab === 'limits' && status === 'live') onRefreshLimits()
  }, [tab, status, onRefreshLimits])

  // A refresh ends when its answer lands: a new report, or a new limits broadcast.
  useEffect(() => setRefreshing((current) => (current === 'cost' ? null : current)), [report])
  useEffect(() => {
    setRefreshing((current) => (current === 'limits' ? null : current))
    setAt(now())
  }, [providerUsage, now])
  useEffect(() => {
    if (refreshing === null) return
    const timer = setTimeout(() => setRefreshing(null), REFRESH_GIVE_UP_MS)
    return () => clearTimeout(timer)
  }, [refreshing])

  const update = (next: Partial<UsagePreferences>) => usagePreferencesStore.set({ ...preferences, ...next })

  const refresh = () => {
    const sent = tab === 'limits' ? onRefreshLimits() : onLoadReport(windowDays)
    if (sent) setRefreshing(tab)
  }

  const summary = useMemo(() => (report === null ? null : summarizeUsage(report)), [report])
  // The previous window's numbers stay up, dimmed, until the asked-for one lands.
  const pending = tab === 'cost' && (report === null || report.windowDays !== windowDays || refreshing === 'cost')
  const offline = status !== 'live'

  const subtitle =
    tab === 'limits'
      ? "What each subscription has left, from the provider's own reading."
      : report !== null && report.windowDays === windowDays
        ? `${formatDayShort(report.since)} to ${formatDayShort(report.until)}`
        : `Last ${String(windowDays)} days`

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-page px-8 pt-10 pb-16 max-[720px]:px-5 max-[720px]:pt-7">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <h1 className="m-0 font-display text-[24px] leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
            <p className="m-0 mt-1 text-[14px] text-muted tabular-nums">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <SegmentedControl label="Usage view" options={tabOptions(id)} value={tab} onChange={(value) => update({ tab: value })} />
            {/* The period does not apply to Limits, so it stays in place but disabled;
                unmounting it would shift the view switch. */}
            <SegmentedControl
              label="Period"
              options={windowOptions(id)}
              value={`${String(windowDays)}` as `${UsageWindowDays}`}
              disabled={tab === 'limits'}
              onChange={(value) => update({ windowDays: Number(value) as UsageWindowDays })}
            />
            <IconButton
              icon={RefreshIcon}
              label={tab === 'limits' ? 'Refresh limits' : 'Refresh usage'}
              aria-busy={refreshing === tab}
              disabled={offline || refreshing === tab}
              className={refreshing === tab ? 'motion-safe:[&_svg]:animate-spin' : ''}
              onClick={refresh}
            />
          </div>
        </header>

        <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
          {tab === 'limits' ? (
            offline && providerUsage.length === 0 ? (
              <p className="m-0 text-[14px] text-muted">Not connected, so there is nothing to read yet.</p>
            ) : (
              <UsageLimits providerUsage={providerUsage} now={at} />
            )
          ) : summary === null || report === null ? (
            <p className="m-0 text-[14px] text-muted">
              {offline ? 'Not connected, so there is nothing to read yet.' : 'Reading usage…'}
            </p>
          ) : (
            <div aria-busy={pending} className={`transition-opacity duration-200 ${pending ? 'opacity-60' : ''}`}>
              <UsageCost summary={summary} prices={report.prices} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
