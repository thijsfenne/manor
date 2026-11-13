/**
 * How long one `active` report keeps the Mac counted as in use. The host repeats it
 * every ~15s, so this survives a few lost beats and still lets a closed lid, a crashed
 * app or a dead socket hand phone pushes back within about a minute.
 */
export const PRESENCE_FRESH_MS = 75_000

export interface DesktopPresence {
  /** One report from a desktop socket. `false` retracts it at once. */
  report(source: object, active: boolean): void
  /** The socket went away: its last report no longer counts. */
  drop(source: object): void
  /**
   * Whether phone pushes should stay quiet, with the evidence for the trace line:
   * how old the freshest `active` report is, or why there is none.
   */
  status(): { active: true; ageMs: number } | { active: false; why: 'never reported' | 'away' | 'stale' }
}

/**
 * The Mac's presence as the desktop host last reported it. Held in memory only: a
 * restarted server knows nothing, which counts as absent, so pushes go out.
 */
export function createDesktopPresence(options: { now?: () => number } = {}): DesktopPresence {
  const now = options.now ?? Date.now
  const reports = new Map<object, number | null>()
  let reported = false

  return {
    report(source, active) {
      reported = true
      reports.set(source, active ? now() : null)
    },
    drop(source) {
      reports.delete(source)
    },
    status() {
      let freshest: number | null = null
      let stale = false
      for (const at of reports.values()) {
        if (at === null) continue
        if (now() - at <= PRESENCE_FRESH_MS) freshest = Math.max(freshest ?? at, at)
        else stale = true
      }
      if (freshest !== null) return { active: true, ageMs: now() - freshest }
      if (!reported) return { active: false, why: 'never reported' }
      return { active: false, why: stale ? 'stale' : 'away' }
    },
  }
}
