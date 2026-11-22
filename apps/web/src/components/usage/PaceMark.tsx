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
