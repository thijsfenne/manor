import type { Store } from './store.js'

/**
 * How long a chat may sit quiet before Manor puts it down for the user. Two days,
 * which is long enough that a chat picked up again tomorrow is never touched, and
 * short enough that the inbox is a list of live work rather than an archive.
 */
export const AUTO_SETTLE_AFTER_MS = 2 * 24 * 60 * 60 * 1000

/** How often the sweep runs while the server is up. Cheap: one conditional update. */
export const SETTLE_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface SettleSweepOptions {
  store: Store
  /** Overridable so a test can place the window without touching the clock. */
  now?: number
  idleMs?: number
}

/**
 * Settles every chat that has gone quiet, and answers with the ids it moved so the
 * caller can broadcast a directory when there is something to see.
 *
 * A turn that is still running keeps bumping `lastMessageAt`, so a working chat is
 * exempt without a guard of its own; a chat the user picked back up inside the
 * window is exempt because the store honours `unsettled_at`; a dm or a group is
 * exempt in the store itself, since neither ever settles. Deliberately a plain
 * function rather than a timer: the timer in `main.ts` calls it, and so can a test.
 */
export async function sweepIdleChats({
  store,
  now = Date.now(),
  idleMs = AUTO_SETTLE_AFTER_MS,
}: SettleSweepOptions): Promise<string[]> {
  return store.settleIdleChats(now - idleMs)
}
