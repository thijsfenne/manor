import type { Row } from '@manor/client-runtime/state'

/**
 * The transcript list's keys, where they differ from the row keys: a stored message keeps
 * the key of the optimistic copy it replaced. Both draw the same bubble, and a new key
 * would make the list drop a measured row for an unmeasured one, which lays everything
 * under it out at an estimated height for a frame and moves the working indicator.
 *
 * Fed the rows before and after each change; returns `carried` itself when nothing landed.
 * The client drops a pending copy for the first stored message with the same text, so
 * the match here is the same: by text, oldest first.
 */
export function carryPendingKeys(previous: readonly Row[], next: readonly Row[], carried: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const nextKeys = new Set(next.map((row) => row.key))
  const gone = previous.filter((row): row is Extract<Row, { kind: 'pending' }> => row.kind === 'pending' && !nextKeys.has(row.key))
  if (gone.length === 0) return carried
  const previousKeys = new Set(previous.map((row) => row.key))
  let keys: Map<string, string> | undefined
  for (const row of next) {
    if (row.kind !== 'event' || previousKeys.has(row.key) || carried.has(row.key)) continue
    const { event } = row
    if (event.type !== 'user_message') continue
    const at = gone.findIndex((pending) => pending.text === event.text)
    if (at === -1) continue
    keys ??= new Map(carried)
    keys.set(row.key, gone[at]!.key)
    gone.splice(at, 1)
  }
  return keys ?? carried
}
