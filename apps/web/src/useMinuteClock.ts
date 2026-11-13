import { useEffect, useState } from 'react'

/** The coarsest unit any age in a list is stated in, so nothing finer is worth a tick. */
const MINUTE_MS = 60_000

/**
 * The clock relative ages are read against, refreshed once a minute. Without it a
 * `3m` sits there saying `3m` for an hour whenever nothing else re-renders the list,
 * which is the lying-label rule with a different face. One render a minute is not an
 * animation: nothing moves, and only the labels that changed repaint.
 *
 * Held once per list rather than once per row, so every age in a panel is read
 * against the same instant.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}
