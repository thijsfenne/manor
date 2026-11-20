import type { Row } from '@manor/client-runtime/state'

/**
 * How a new DM row comes in. `send` flies up from the composer field, `fade` is laid out
 * in place and fades in at the end of the chat's slide.
 */
export type Arrival = 'send' | 'fade'

/**
 * The one spring every arrival moves on: critically damped (damping is twice the root of
 * stiffness times mass), so nothing overshoots, and nine tenths of the way in about 250ms.
 */
export const ARRIVAL_SPRING = { stiffness: 240, damping: 31, mass: 1 } as const

/**
 * The rows that came in at the end of the transcript since the last pass, by list key.
 * History loading into an empty transcript and older history paging in above bring no
 * arrivals, but a send into an empty chat does; only a user message and an agent turn
 * arrive, everything else just appears. `flight` names the one send the composer asked
 * to fly, so a message sent from another device fades in like a reply instead.
 */
export function tailArrivals(
  previous: readonly Row[],
  next: readonly Row[],
  keyOf: (row: Row) => string,
  flight: boolean,
): ReadonlyMap<string, Arrival> {
  if (previous.length === 0 && !flight) return NO_ARRIVALS
  const seen = new Set(previous.map(keyOf))
  let arrivals: Map<string, Arrival> | undefined
  let flying = flight
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const row = next[index]!
    const key = keyOf(row)
    if (seen.has(key)) break
    const user = row.kind === 'pending' || (row.kind === 'event' && row.event.type === 'user_message')
    if (!user && row.kind !== 'turn') continue
    arrivals ??= new Map()
    // Only the newest message he sent can be the one that left the field.
    arrivals.set(key, user && flying ? 'send' : 'fade')
    if (user) flying = false
  }
  return arrivals ?? NO_ARRIVALS
}

export const NO_ARRIVALS: ReadonlyMap<string, Arrival> = new Map()
