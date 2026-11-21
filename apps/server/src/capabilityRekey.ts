export type RekeyResult = 'rekeyed' | 'unknown' | 'conflict'

/**
 * Moves one capability to the token a live provider process already holds, so that
 * token means the turn now attached to the process. Unknown when no entry has `from`;
 * a conflict when `to` is still a live capability, which must never be overwritten.
 */
export function rekeyEntry<T>(entries: Map<string, T>, from: string, to: string): RekeyResult {
  const entry = entries.get(from)
  if (entry === undefined) return 'unknown'
  if (from === to) return 'rekeyed'
  if (entries.has(to)) return 'conflict'
  entries.delete(from)
  entries.set(to, entry)
  return 'rekeyed'
}

/** The first registry that knows `from` decides; none knowing it is unknown. */
export function rekeyAcross(registries: readonly { rekey(from: string, to: string): RekeyResult }[], from: string, to: string): RekeyResult {
  for (const registry of registries) {
    const result = registry.rekey(from, to)
    if (result !== 'unknown') return result
  }
  return 'unknown'
}
