const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * How long ago something happened, in the width of a badge: `now`, `29m`, `3h`,
 * `2d`, `40w`. One unit and no words, because it sits at the end of a row whose
 * title is the thing worth reading. Rounded down, so a label never claims more
 * time has passed than has; anything still in the future reads as `now` rather
 * than as a negative age, which is what a clock skew between the server's stamp
 * and this browser would otherwise produce.
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const elapsed = now - ts
  if (!Number.isFinite(elapsed) || elapsed < MINUTE_MS) return 'now'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`
  if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d`
  return `${Math.floor(elapsed / (7 * DAY_MS))}w`
}
