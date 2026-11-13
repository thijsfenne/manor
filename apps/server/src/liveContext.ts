import type { LiveContext } from '@manor/contracts'

/**
 * Readings closer together than this merge into one message, so a fast tool loop
 * repaints the composer's meter at most once a second. Compaction edges never wait.
 */
export const LIVE_CONTEXT_INTERVAL_MS = 1_000

export interface LiveContextTracker {
  /** The prompt size of the request that just answered; window and threshold carry over when absent. */
  reading(contextTokens: number, contextWindow?: number, autoCompactTokens?: number): void
  compaction(phase: 'start' | 'end' | 'failed', contextTokens?: number): void
  /**
   * The attempt ended. A compaction it never closed is over, and a reading still
   * waiting for its slot goes out now so the snapshot and the clients agree.
   */
  settle(): void
}

const same = (a: LiveContext | undefined, b: LiveContext | undefined) =>
  a !== undefined && b !== undefined &&
  a.contextTokens === b.contextTokens && a.contextWindow === b.contextWindow &&
  a.autoCompactTokens === b.autoCompactTokens && a.compacting === b.compacting && a.compacted === b.compacted

/**
 * One running turn's live context state. `publish` receives the whole state each time,
 * never a patch, so a dropped message is repaired by the next one.
 */
export function createLiveContext(
  publish: (context: LiveContext) => void,
  interval = LIVE_CONTEXT_INTERVAL_MS,
  clock: () => number = Date.now,
): LiveContextTracker {
  let current: LiveContext | undefined
  let sent: LiveContext | undefined
  let sentAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (current === undefined || same(current, sent)) return
    sent = current
    sentAt = clock()
    publish(current)
  }
  const update = (next: LiveContext, urgent: boolean) => {
    if (same(next, current)) return
    current = next
    if (urgent) return flush()
    if (timer !== undefined) return
    const wait = sentAt + interval - clock()
    if (wait <= 0) flush()
    else timer = setTimeout(flush, wait)
  }
  // The window and the compaction threshold describe the session, not one request.
  const scale = (contextWindow = current?.contextWindow, autoCompactTokens = current?.autoCompactTokens) => ({
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
  })

  return {
    reading(contextTokens, contextWindow, autoCompactTokens) {
      update({
        contextTokens,
        ...scale(contextWindow, autoCompactTokens),
        compacting: current?.compacting ?? false,
      }, false)
    },
    compaction(phase, contextTokens) {
      if (phase === 'start' || phase === 'failed') {
        update({ ...current, compacting: phase === 'start' }, true)
        return
      }
      // The size from before is history now: the new one, or nothing until the next request.
      update({
        ...(contextTokens === undefined ? {} : { contextTokens }),
        ...scale(),
        compacting: false,
        compacted: true,
      }, true)
    },
    settle() {
      if (current?.compacting === true) update({ ...current, compacting: false }, true)
      else flush()
    },
  }
}
