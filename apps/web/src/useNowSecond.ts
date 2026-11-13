import { useSyncExternalStore } from 'react'

/**
 * One clock for every working timer, ticking on wall-clock second boundaries. Each timer
 * used to run its own interval on its own phase, so several working chats repainted
 * several times a second; now they all update in the same frame, and the timeout only
 * runs while a label is mounted.
 */
const currentSecond = () => Math.floor(Date.now() / 1_000) * 1_000

let second = currentSecond()
let timer: number | undefined
const listeners = new Set<() => void>()

function schedule() {
  timer = window.setTimeout(() => {
    second = currentSecond()
    for (const listener of listeners) listener()
    schedule()
  }, 1_000 - (Date.now() % 1_000))
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    // The render that subscribed may be a while old; React rechecks the snapshot right after this.
    second = currentSecond()
    schedule()
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.clearTimeout(timer)
      timer = undefined
    }
  }
}

// Between ticks the cached second is returned untouched, as useSyncExternalStore requires;
// with nobody subscribed it is read fresh, so a label that mounts late is never stale.
function getSnapshot() {
  if (timer === undefined) second = currentSecond()
  return second
}

const subscribeIdle = () => () => undefined
const idle = () => 0

/** The current whole second in epoch ms. Pass `false` while nothing is counting: no subscription, a constant 0. */
export function useNowSecond(active = true): number {
  return useSyncExternalStore(active ? subscribe : subscribeIdle, active ? getSnapshot : idle, active ? getSnapshot : idle)
}
