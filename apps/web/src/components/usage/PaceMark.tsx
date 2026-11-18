import type { UsageWindow } from '@manor/contracts'
import { elapsedShare } from '@manor/client-runtime/usage'

/**
 * Where even spending would put a bar that shows quota left: the share of the
 * window's time still to run, 0..100. Null when the provider gave no window timing.
 */
export function paceMarkPercent(window: UsageWindow, now: number): number | null {
  const elapsed = elapsedShare(window, now)
  return elapsed === null ? null : Math.round((1 - elapsed) * 100)
}

/**
 * The hairline on a limit bar, for the Usage view's Limits tab and the Usage dialog,
 * at `paceMarkPercent`. Place it inside a `relative` bar; `className` sets its colour
 * and how far it reaches above and below.
 */
export function PaceMark({ at, className }: { at: number | null; className: string }) {
  if (at === null) return null
  return (
    <span
      aria-hidden
      data-pace-mark
      className={`absolute w-px -translate-x-1/2 ${className}`}
      style={{ left: `${String(at)}%` }}
    />
  )
}
