/** Release speed, in points per second, past which a swipe goes the way it was flung. */
export const PAGER_FLING = 500

/**
 * Which page a sideways swipe lands on when the finger lifts. `progress` is 0 on the
 * first page and 1 on the second; a swipe to the left (negative `velocityX`) heads for
 * the second. A swipe the system cancelled lands where it was heading before it began,
 * so a cancel never turns a page. Otherwise a fling wins, and a slow release lands on
 * the nearer page.
 */
export function pagerSettle(progress: number, velocityX: number, cancelled: boolean, heading: 0 | 1): 0 | 1 {
  'worklet'
  if (cancelled) return heading
  if (Math.abs(velocityX) > PAGER_FLING) return velocityX < 0 ? 1 : 0
  return progress > 0.5 ? 1 : 0
}
