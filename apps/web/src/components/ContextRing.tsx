import { memo, useRef, useState } from 'react'
import {
  contextBreakdown,
  contextProvenance,
  readContextMeter,
  type ContextMeter,
  type ContextRowKey,
} from '@manor/client-runtime/context-meter'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'

const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Segment colours are existing theme tokens, so both themes and the bar stay in step. */
const ROWS: Record<ContextRowKey, { label: string; swatch: string }> = {
  messages: { label: 'Messages', swatch: 'bg-busy' },
  mcp: { label: 'MCP tools', swatch: 'bg-series-claude' },
  memory: { label: 'Memory', swatch: 'bg-warn-fill' },
  instructions: { label: 'Instructions', swatch: 'bg-muted' },
  skills: { label: 'Skills', swatch: 'bg-skill' },
}

/**
 * One session meter for Single Work. The dial is the old room ring; the card is
 * a readout (percent, used/window, model window, compact when needed).
 */
// Memoized because the composer re-renders on every streamed token, while the meter's
// props only change when a live reading lands, at most once a second.
export const ContextRing = memo(function ContextRing({ used, window, estimate, controlSize }: ContextMeter & { controlSize: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const meter = readContextMeter(used, window, estimate)
  const breakdown = contextBreakdown(used, estimate, meter.limit)
  const source = contextProvenance(estimate)

  useDismiss(open, () => setOpen(false), { within: [rootRef], escape: true })

  // Three different sentences on purpose. A driver that reports nothing is named as
  // such; a reading that exists is shown against a window that says where it came from.
  const usage = meter.usedLabel === null
    ? source.used?.source === 'unknown' ? 'This provider reports no fill' : 'Not reported yet'
    : `${meter.percent}%, ${meter.usedLabel}/${meter.limitLabel}`

  return (
    <div ref={rootRef} className="relative flex-none">
      <button
        type="button"
        className={`grid cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted hover:bg-user-bg hover:text-text ${controlSize}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Context window"
        onClick={() => setOpen((current) => !current)}
      >
        <Ring fraction={meter.fraction} warns={meter.warns} reported={meter.reported} />
        <span className="sr-only">Context window {usage}</span>
      </button>

      <Popover
        open={open}
        origin="bottom-right"
        className="absolute right-0 bottom-[calc(100%+8px)] z-[6] w-[min(320px,calc(100vw-32px))] max-h-[60vh] overflow-y-auto rounded-xl border border-line surface-floating px-3 py-2"
        role="dialog"
        aria-label="Context window"
      >
        <div className="flex flex-col gap-2 leading-snug">
          <p className="m-0 text-meta font-medium text-dim">Context window</p>
          {meter.usedLabel === null ? (
            <p className="m-0 text-label font-medium text-text">{usage}</p>
          ) : (
            <div className="flex items-baseline justify-between gap-3">
              <p className="m-0 whitespace-nowrap text-label font-medium text-text">{`${meter.percent}% used`}</p>
              <p className="m-0 whitespace-nowrap text-meta tabular-nums text-dim">{`${meter.usedLabel} / ${meter.limitLabel}`}</p>
            </div>
          )}
          {breakdown !== undefined && meter.usedLabel !== null ? (
            <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-line" aria-hidden="true">
              {breakdown.rows.map((row) => (
                <span key={row.key} className={`h-full min-w-px ${ROWS[row.key].swatch}`} style={{ width: `${row.share * 100}%` }} />
              ))}
            </div>
          ) : null}
          {breakdown === undefined ? (
            <p className="m-0 text-meta text-dim">A breakdown is available after the next completed turn.</p>
          ) : (
            <>
              <dl className="m-0 mt-0.5 flex flex-col gap-1.5 text-meta">
                {breakdown.rows.map((row) => (
                  <div
                    key={row.key}
                    className="flex items-center gap-2"
                    title={row.key === 'mcp' && breakdown.unmeasuredMcpServers > 0
                      ? `${breakdown.unmeasuredMcpServers} ${breakdown.unmeasuredMcpServers === 1 ? 'connection has' : 'connections have'} no size estimate, so this is a minimum.`
                      : undefined}
                  >
                    <span className={`size-2.5 shrink-0 rounded-sm ${ROWS[row.key].swatch}`} aria-hidden="true" />
                    <dt className="min-w-0 flex-1 text-text">{ROWS[row.key].label}</dt>
                    <dd className="m-0 w-12 shrink-0 text-right tabular-nums text-dim">{row.tokens}</dd>
                    <dd className="m-0 w-12 shrink-0 text-right tabular-nums text-text">{row.percent ?? ''}</dd>
                  </div>
                ))}
              </dl>
              <p
                className="m-0 text-meta text-dim"
                title="Sizes come from the text Manor supplies. The total is the provider's own reading, and what the sized rows do not explain counts as Messages."
              >
                Estimated split
              </p>
            </>
          )}
          {/* The dial divides by the compaction point when there is one, so that is the one
              window the card leads with. The model's own size is context, not a second scale. */}
          <p className="m-0 text-meta text-dim">
            {meter.limitIsCompact
              ? `Compacts at ${meter.limitLabel}, model window ${source.window?.tokens ?? meter.windowLabel}`
              : 'Compacts automatically when needed.'}
          </p>
        </div>
      </Popover>
    </div>
  )
})

/**
 * `reported` draws the track itself: a solid ring is a window someone measured and
 * found empty, a dashed one is a provider that said nothing. Both are 0% full, and
 * without this the dial is the one surface that still cannot tell them apart.
 */
export function Ring({ fraction, warns, reported = true }: { fraction: number; warns: boolean; reported?: boolean }) {
  return (
    <svg className="-rotate-90" width={18} height={18} viewBox="0 0 18 18" aria-hidden="true">
      <circle
        className="stroke-line"
        cx={9}
        cy={9}
        r={RADIUS}
        fill="none"
        strokeWidth={2.5}
        {...(reported ? {} : { strokeDasharray: '2 2.5' })}
      />
      {fraction > 0 ? (
        <circle
          cx={9}
          cy={9}
          r={RADIUS}
          fill="none"
          strokeWidth={2.5}
          strokeLinecap="round"
          className={`${warns ? 'stroke-warn-fill' : 'stroke-muted'} transition-[stroke-dasharray] duration-[400ms] ease-arrive motion-reduce:transition-none`}
          strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
        />
      ) : null}
    </svg>
  )
}
