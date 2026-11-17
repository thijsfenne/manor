/**
 * Which tasks cards the user opened or closed by hand, by card key. Memory only: a card
 * keeps its choice while its chat stays open and its row re-renders or remounts, and a
 * restart forgets it. A card with no choice follows `byDefault` (see `foldsWhenDone`).
 * Web and phone read it through `useSyncExternalStore`.
 */
const chosen = new Map<string, boolean>()
const listeners = new Set<() => void>()

export const isTaskFolded = (key: string, byDefault = false): boolean => chosen.get(key) ?? byDefault

/** Flips the card from whatever it shows now, so a press always does something visible. */
export function toggleTaskFolded(key: string, byDefault = false) {
  chosen.set(key, !isTaskFolded(key, byDefault))
  listeners.forEach((listener) => listener())
}

export function subscribeTaskFolds(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
