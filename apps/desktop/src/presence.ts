/**
 * The main-to-renderer channel for presence. The sandboxed preload cannot import this
 * module, so it repeats the literal and `smoke:preload` proves the two still agree.
 */
export const PRESENCE_CHANNEL = 'manor:presence'
/** Idle time after which the Mac stops counting as in use. */
export const PRESENCE_IDLE_SECONDS = 120
/** One check, and one heartbeat while active. The server forgets a report after 75s. */
export const PRESENCE_BEAT_MS = 15_000

/** The slice of Electron's `powerMonitor` the monitor needs; a fake stands in for tests. */
export interface PresencePower {
  getSystemIdleState(idleThresholdSeconds: number): 'active' | 'idle' | 'locked' | 'unknown'
  on(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', listener: () => void): void
  off(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', listener: () => void): void
}

export interface PresenceMonitor {
  /** The current value, for a renderer that subscribed after the last report. */
  current(): boolean
  stop(): void
}

/**
 * Whether the user is using this Mac: awake, unlocked, and input within the last two
 * minutes in any app. Reported on every change and repeated every beat while true, so
 * the server can tell "still here" from "the app died". Lock, unlock, suspend and
 * resume re-evaluate at once instead of waiting for the next beat; `unknown` from the
 * system counts as away, because a wrong "away" costs a duplicate buzz and a wrong
 * "here" costs a missed one.
 */
export function createPresenceMonitor(options: {
  power: PresencePower
  report: (active: boolean) => void
  idleSeconds?: number
  beatMs?: number
  setInterval?: (run: () => void, ms: number) => () => void
}): PresenceMonitor {
  const { power, report } = options
  const idleSeconds = options.idleSeconds ?? PRESENCE_IDLE_SECONDS
  let locked = false
  let suspended = false
  let active = false
  const every = options.setInterval ?? ((run, ms) => {
    const timer = setInterval(run, ms)
    return () => clearInterval(timer)
  })

  const evaluate = (): boolean => !locked && !suspended && power.getSystemIdleState(idleSeconds) === 'active'

  // Called on a change and on every beat: a beat is the same report again, but only
  // while active, since silence is already how an away Mac is known.
  const tick = (beat: boolean) => {
    const next = evaluate()
    if (next === active && !(beat && next)) return
    active = next
    report(next)
  }

  const events = {
    'lock-screen': () => { locked = true; tick(false) },
    'unlock-screen': () => { locked = false; tick(false) },
    suspend: () => { suspended = true; tick(false) },
    resume: () => { suspended = false; tick(false) },
  } as const
  for (const [name, listener] of Object.entries(events)) power.on(name as keyof typeof events, listener)
  const stopBeat = every(() => tick(true), options.beatMs ?? PRESENCE_BEAT_MS)
  tick(false)

  return {
    current: () => active,
    stop() {
      stopBeat()
      for (const [name, listener] of Object.entries(events)) power.off(name as keyof typeof events, listener)
    },
  }
}
