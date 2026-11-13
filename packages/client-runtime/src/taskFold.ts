/**
 * Which tasks cards the user folded shut, by card key. Memory only: a card keeps its fold
 * while its chat stays open and its row re-renders or remounts, and a restart opens
 * everything again. Web and phone read it through `useSyncExternalStore`.
 */
const folded = new Set<string>()
const listeners = new Set<() => void>()

export const isTaskFolded = (key: string): boolean => folded.has(key)

export function toggleTaskFolded(key: string) {
  if (!folded.delete(key)) folded.add(key)
  listeners.forEach((listener) => listener())
}

export function subscribeTaskFolds(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
