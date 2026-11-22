import { useState } from 'react'
import { ArrowRight01Icon, DashboardSpeed02Icon } from '@hugeicons/core-free-icons'
import type { ProviderConnection, ProviderUsage, UsageWindow } from '@manor/contracts'
import {
  STALE_AFTER_MS,
  WINDOW_DETAILS,
  byCardOrder,
  clockOf,
  connectedUsage,
  heatOf,
  paceMarkPercent,
  remainingPercent,
  resetLabel,
  usageRing,
  type Heat,
} from '@manor/client-runtime/usage'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { ProviderMark } from './ProviderMark'
import { PaceMark } from './usage/PaceMark'
import { useMinuteClock } from '../useMinuteClock'

/**
 * How much of each subscription is left, for the whole house, as the sidebar's
 * footer row and the dialog behind it. The reading itself — percentages, heat,
 * reset labels, card order — is shared with the mobile app and lives in
 * `@manor/client-runtime/usage`; what is here is only how the web draws it.
 *
 * How much of a provider's plan is spent, including work done outside Manor
 * entirely. That is not how full a conversation is, which is why this panel never
 * sat next to a per-chat context gauge.
 */

const heatText = (heat: Heat) => (heat === 'critical' ? 'text-danger' : heat === 'warn' ? 'text-warn' : 'text-muted')
const heatBar = (heat: Heat) => (heat === 'critical' ? 'bg-danger' : heat === 'warn' ? 'bg-warn-fill' : 'bg-muted')

interface UsagePanelProps {
  perProvider: readonly ProviderUsage[]
  /** The provider sign-in rows; the dialog leaves out a provider that is not connected. */
  connections: readonly ProviderConnection[]
  /** Opens the Usage view in the main window and closes the dialog behind it. */
  onOpenDetails: () => void
  /** True while that view is the one on screen, so the row reads as the current place. */
  active?: boolean
  /** Injected so the reset arithmetic is testable without freezing a real clock. */
  now?: () => number
}

const RING_SIZE = 28
const RING_STROKE = 2.5
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const heatStroke = (heat: Heat) => (heat === 'critical' ? 'stroke-danger' : heat === 'warn' ? 'stroke-warn-fill' : 'stroke-muted')

/**
 * Sits at the foot of the navigation rail as one ring per provider, its mark in
 * the middle and the ring filled to what is left of that provider's fullest window,
 * as the Usage view's Limits bars are: a full ring is a fresh plan. A provider
 * that did not answer is left out rather than drawn as an empty ring, which would
 * read as an unused plan. With nothing reported yet the gauge mark holds the
 * place, so the slot never goes blank.
 *
 * It opens a centred dialog rather than a popover hung off its side. Four providers
 * with every window they report do not fit beside a rail, and a popover that
 * outgrows the screen is a modal that has not admitted it yet.
 */
export function UsagePanel({ perProvider, connections, onOpenDetails, active = false, now = Date.now }: UsagePanelProps) {
  const [open, setOpen] = useState(false)

  const rings = [...perProvider].sort(byCardOrder).flatMap((usage) => usageRing(usage) ?? [])
  const reading = rings
    .map((ring) => `${ring.provider.charAt(0).toUpperCase()}${ring.provider.slice(1)} ${String(ring.left)}% left`)
    .join(', ')
  const label = rings.length === 0 ? 'Usage' : `Usage, ${reading}`

  return (
    <div className="relative">
      <button
        type="button"
        className={`flex w-10 cursor-pointer flex-col items-center gap-1.5 rounded-xl border-0 py-1.5 ${
          open || active ? 'bg-surface-2' : 'bg-transparent hover:bg-surface-2'
        } ${rings.length === 0 ? 'h-9 justify-center text-muted' : ''}`}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {rings.length === 0 ? (
          <Icon icon={DashboardSpeed02Icon} size={18} className="opacity-70" />
        ) : (
          rings.map((ring) => <UsageRing key={ring.provider} {...ring} />)
        )}
      </button>

      {open ? (
        <Modal title="Usage" width="wide" onClose={() => setOpen(false)}>
          <LiveUsageDialog
            perProvider={perProvider}
            connections={connections}
            now={now}
            onOpenDetails={() => {
              setOpen(false)
              onOpenDetails()
            }}
          />
        </Modal>
      ) : null}
    </div>
  )
}

function UsageRing({ provider, left, heat }: { provider: ProviderUsage['provider']; left: number; heat: Heat }) {
  // `remainingPercent` is already clamped, so a spent plan draws no arc at all.
  const fraction = left / 100
  const centre = RING_SIZE / 2

  return (
    <span className="relative grid flex-none place-items-center" style={{ width: RING_SIZE, height: RING_SIZE }} data-usage-ring={provider}>
      <svg className="absolute inset-0 -rotate-90" width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${String(RING_SIZE)} ${String(RING_SIZE)}`} aria-hidden="true">
        <circle className="stroke-line" cx={centre} cy={centre} r={RING_RADIUS} fill="none" strokeWidth={RING_STROKE} />
        {fraction > 0 ? (
          <circle
            className={`${heatStroke(heat)} transition-[stroke-dasharray] duration-[400ms] ease-arrive motion-reduce:transition-none`}
            cx={centre}
            cy={centre}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={`${String(RING_CIRCUMFERENCE * fraction)} ${String(RING_CIRCUMFERENCE)}`}
          />
        ) : null}
      </svg>
      <span className="relative inline-flex">
        <ProviderMark driver={provider} size={12} centred />
      </span>
    </span>
  )
}

/** Reset labels and pace marks move with the clock while the dialog stays open. */
function LiveUsageDialog({ now, ...props }: Omit<Parameters<typeof UsageDialogContent>[0], 'now'> & { now: () => number }) {
  useMinuteClock()
  return <UsageDialogContent {...props} now={now()} />
}

/**
 * The dialog's body, separate from the shell so the cards are testable without a
 * DOM: the shell portals to the body, which the server renderer in the tests does
 * not support.
 */
export function UsageDialogContent({
  perProvider,
  connections,
  now,
  onOpenDetails,
}: {
  perProvider: readonly ProviderUsage[]
  connections: readonly ProviderConnection[]
  now: number
  onOpenDetails: () => void
}) {
  const shown = connectedUsage(perProvider, connections)
  return (
    <>
      {shown.length === 0 ? (
        <p className="m-0 text-[14px] text-dim">No connected provider is reporting usage.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {shown.sort(byCardOrder).map((usage) => (
            <ProviderCard key={usage.provider} usage={usage} now={now} />
          ))}
        </div>
      )}

      {/* The way out of the thermometer and into the history behind it. It sits
          below every card rather than in the title row, because it leads away from
          what this dialog is for and should be read last. The dialog closes on the
          way: leaving it hanging over the view it just opened is a second thing to
          dismiss. */}
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1 self-start border-0 bg-transparent p-0 text-[13px] text-muted hover:text-text"
        onClick={onOpenDetails}
      >
        <span>Usage details</span>
        <Icon icon={ArrowRight01Icon} size={14} className="opacity-70" />
      </button>
    </>
  )
}

function ProviderCard({ usage, now }: { usage: ProviderUsage; now: number }) {
  const stale = now - usage.fetchedAt > STALE_AFTER_MS
  const note = usage.status === 'ok' && stale ? clockOf(usage.fetchedAt) : undefined

  return (
    // A fill rather than a hairline: on the dialog's surface a border reads as four
    // boxes drawn on top of it, while `surface-2` makes each provider its own card.
    <section className="rounded-xl bg-surface-2 p-4">
      <header className="flex items-center gap-2">
        <ProviderMark driver={usage.provider} size={14} />
        <span className="text-[14px] font-medium text-text capitalize">{usage.provider}</span>
        <span className="ml-auto flex gap-2 text-label whitespace-nowrap text-dim">
          {usage.plan === undefined ? null : <span className="capitalize">{usage.plan}</span>}
          {note === undefined ? null : <span>at {note}</span>}
        </span>
      </header>

      {usage.status === 'unavailable' ? (
        // No bar, no zero. A provider that did not answer has no number, and drawing
        // an empty meter for it would read as a completely unused plan.
        <p className="m-0 pt-3 text-[14px] text-dim">Unavailable</p>
      ) : (
        usage.windows.map((limit) => (
          <LimitRow key={limit.label} limit={limit} now={now} detail={WINDOW_DETAILS[usage.provider]?.[limit.label]} />
        ))
      )}
    </section>
  )
}

function LimitRow({ limit, now, detail }: { limit: UsageWindow; now: number; detail?: string }) {
  const heat = heatOf(limit)
  const reset = resetLabel(limit.resetsAt, now)

  return (
    // The gap above the bar is smaller than the gap between rows, so a bar reads as
    // belonging to the line above it rather than floating between two of them.
    <div className="pt-4 first:pt-2">
      <div className="flex items-baseline gap-2 text-[14px]">
        <span className="min-w-0 truncate font-medium text-text">{limit.label}</span>
        {/* The reset and the reading never wrap; a long window name truncates instead. */}
        {reset === '' ? null : <span className="ml-auto text-label whitespace-nowrap text-dim">{reset}</span>}
        <span className={`tabular-nums whitespace-nowrap ${reset === '' ? 'ml-auto' : ''} ${heatText(heat)}`}>
          {remainingPercent(limit)}% left
        </span>
      </div>
      <div className="relative mt-2 h-[5px] rounded-full bg-line">
        <div
          className={`h-full rounded-full ${heatBar(heat)}`}
          // What is left, as on the Usage view's Limits tab: a full bar is a fresh plan.
          style={{ width: `${String(remainingPercent(limit))}%` }}
        />
        {/* The text tone, where the Limits tab uses muted: here the fill is muted itself. */}
        <PaceMark at={paceMarkPercent(limit, now)} className="-inset-y-0.5 bg-text" />
      </div>
      {detail === undefined ? null : <p className="m-0 mt-1.5 text-meta text-dim">{detail}</p>}
    </div>
  )
}
