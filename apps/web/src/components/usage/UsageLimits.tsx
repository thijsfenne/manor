import type { ProviderUsage, UsageWindow } from '@manor/contracts'
import {
  PACE_LABEL,
  STALE_AFTER_MS,
  byCardOrder,
  clockOf,
  elapsedShare,
  paceOf,
  remainingPercent,
  resetsIn,
  type LimitPace,
} from '@manor/client-runtime/usage'
import { ChartDecreaseIcon, ChartIncreaseIcon, DashboardSpeed01Icon } from '@hugeicons/core-free-icons'
import { Icon } from '../Icon'
import { ProviderMark } from '../ProviderMark'
import { UsageHint } from './UsageHint'
import { PROVIDER_PRESENTATION } from './usageProviders'

/**
 * How much subscription quota is left, per provider and per window. Every number is the provider's own reading; the bar shows what is left,
 * and the hairline on it is where even spending would have put the fill.
 */

const PACE_ICON: Record<LimitPace, typeof DashboardSpeed01Icon> = {
  ahead: ChartIncreaseIcon,
  on: DashboardSpeed01Icon,
  under: ChartDecreaseIcon,
}

const resetMoment = (at: number) =>
  new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

export function UsageLimits({ providerUsage, now }: { providerUsage: readonly ProviderUsage[]; now: number }) {
  if (providerUsage.length === 0) {
    return <p className="m-0 text-[14px] text-muted">No provider reports subscription limits yet.</p>
  }
  return (
    <div className="flex flex-col gap-8">
      {[...providerUsage].sort(byCardOrder).map((usage) => (
        <ProviderLimits key={usage.provider} usage={usage} now={now} />
      ))}
    </div>
  )
}

function ProviderLimits({ usage, now }: { usage: ProviderUsage; now: number }) {
  const stale = usage.status === 'ok' && now - usage.fetchedAt > STALE_AFTER_MS
  return (
    <section className="flex flex-col gap-3" aria-label={PROVIDER_PRESENTATION[usage.provider].label}>
      <h2 className="m-0 flex items-center gap-2 text-[14px] font-medium text-text">
        <ProviderMark driver={usage.provider} size={15} />
        {PROVIDER_PRESENTATION[usage.provider].label}
        {usage.plan === undefined ? null : <span className="font-normal text-dim capitalize">{usage.plan}</span>}
        {/* An old reading says how old, so a full bar is never taken for a fresh one. */}
        {stale ? <span className="ml-auto text-meta font-normal text-dim">Read at {clockOf(usage.fetchedAt)}</span> : null}
      </h2>
      {usage.status === 'unavailable' ? (
        <p className="m-0 rounded-panel border border-line px-4 py-3.5 text-label text-muted">
          Subscription usage unavailable. Manor asks again on the next refresh.
        </p>
      ) : usage.windows.length === 0 ? (
        <p className="m-0 rounded-panel border border-line px-4 py-3.5 text-label text-muted">No subscription limits reported.</p>
      ) : (
        usage.windows.map((window) => (
          <LimitCard key={window.label} provider={usage.provider} window={window} now={now} />
        ))
      )}
    </section>
  )
}

function LimitCard({ provider, window, now }: { provider: ProviderUsage['provider']; window: UsageWindow; now: number }) {
  const remaining = remainingPercent(window)
  const pace = paceOf(window, now)
  const reset = resetsIn(window, now)
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-panel border border-line p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <span className="text-label font-medium text-text">{window.label}</span>
        <span className="flex items-baseline gap-2">
          <span className="text-[30px] leading-none font-semibold text-text tabular-nums">{remaining}%</span>
          <span className="text-label text-muted">left</span>
          {pace === null ? null : (
            <UsageHint label={PACE_LABEL[pace]} hint={PACE_LABEL[pace]} className="inline-flex self-center rounded-sm text-muted">
              <Icon icon={PACE_ICON[pace]} size={15} />
            </UsageHint>
          )}
        </span>
        <span className="text-meta text-dim tabular-nums">{reset ?? 'Reset not reported'}</span>
      </div>
      <WindowBar color={PROVIDER_PRESENTATION[provider].color} window={window} now={now} />
    </div>
  )
}

/**
 * One window as a bar from the moment it opened to its reset. The fill is quota left,
 * so the even-spending mark is the share of time left: a fill short of the line is
 * spending faster than the clock.
 */
function WindowBar({ color, window, now }: { color: string; window: UsageWindow; now: number }) {
  const remaining = remainingPercent(window)
  const elapsed = elapsedShare(window, now)
  const timeLeft = elapsed === null ? null : Math.round((1 - elapsed) * 100)
  const reset = resetsIn(window, now)
  const summary = `${window.label}: ${String(remaining)}% left${
    timeLeft === null ? '' : `, ${String(timeLeft)}% of the window left`
  }${reset === null ? '' : `, ${reset}`}`
  return (
    <UsageHint
      label={summary}
      className="relative block h-6 rounded-full"
      hint={
        <span className="flex flex-col gap-0.5">
          <span className="text-text">
            {remaining}% left{timeLeft === null ? '' : `, ${String(timeLeft)}% of the window left`}
          </span>
          {timeLeft === null ? null : <span>The line is where even spending would be.</span>}
          {window.resetsAt === undefined ? null : (
            <span>
              Resets {resetMoment(window.resetsAt)}
              {reset === null ? '' : `, ${reset}`}
            </span>
          )}
        </span>
      }
    >
      <span aria-hidden className="absolute inset-x-0 inset-y-1.5 rounded-full bg-user-bg" />
      {remaining > 0 ? (
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 rounded-full"
          style={{ width: `${String(remaining)}%`, backgroundColor: color }}
        />
      ) : null}
      {timeLeft === null ? null : (
        <span
          aria-hidden
          className="absolute inset-y-0.5 w-px -translate-x-1/2 bg-muted"
          style={{ left: `${String(timeLeft)}%` }}
        />
      )}
    </UsageHint>
  )
}
