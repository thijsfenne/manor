/**
 * A turn's two clocks, shared by every process-spawning driver.
 *
 * A single wall-clock cap cannot tell a hung CLI from a working one: a turn that
 * is halfway through a real implementation dies exactly like a turn that stopped
 * talking an hour ago. So the clock that usually fires is the idle one, reset on
 * every runtime event the parser emits. The overall cap is off by default; it used
 * to kill real work at twenty minutes. A caller that wants one (chat naming, 60s)
 * still pins it, and `MANOR_TURN_TIMEOUT_MS` puts one back on every turn.
 */

/** No output for this long means hung, whatever the turn was doing before. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Off: zero means no overall clock. Restore one with `MANOR_TURN_TIMEOUT_MS`. */
export const DEFAULT_TURN_TIMEOUT_MS = 0

/** Longest a turn that answered stays open for the background work it started. */
export const DEFAULT_BACKGROUND_HOLD_MS = 30 * 60 * 1000

/**
 * The mid-turn note a background hold ends with at its cap, naming what still ran.
 * The caller redacts it: the names come from the persona's own commands and briefs.
 */
export function backgroundCapNote(holdMs: number, running: readonly string[], provider: string): string {
  const waited = `${Math.round(holdMs / 60_000)} minutes`
  return running.length > 0
    ? `Stopped waiting for background work after ${waited}. Still running: ${running.join('; ')}.`
    : `Stopped waiting after ${waited} for ${provider} to report on finished background work.`
}

export interface TurnTimeoutOptions {
  /** Overall cap for the whole turn. Zero means none. */
  timeoutMs?: number
  /** Longest silence tolerated between two runtime events. */
  idleTimeoutMs?: number
}

export interface TurnTimeouts {
  idleMs: number
  /** Zero means the overall clock is not armed. */
  overallMs: number
}

const positive = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Overall may be zero (no cap). Idle may not: a turn with no clock never dies. */
const nonNegative = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Explicit options win over the environment, which wins over the defaults. A caller
 * that pins a short overall budget (chat naming asks for 60s) means that budget, so
 * the idle clock is capped to it rather than outliving the turn it guards. An
 * overall of zero leaves the idle clock alone.
 */
export function resolveTurnTimeouts(
  options: TurnTimeoutOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): TurnTimeouts {
  const overallMs = options.timeoutMs ?? nonNegative(env['MANOR_TURN_TIMEOUT_MS']) ?? DEFAULT_TURN_TIMEOUT_MS
  const idle =
    options.idleTimeoutMs ?? positive(env['MANOR_TURN_IDLE_TIMEOUT_MS']) ?? DEFAULT_IDLE_TIMEOUT_MS
  return { idleMs: overallMs > 0 ? Math.min(idle, overallMs) : idle, overallMs }
}

const inSeconds = (ms: number) => `${Math.round(ms / 1000)}s`

/** Minutes once there are whole ones to say; "1200s" tells nobody anything. */
const inMinutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : inSeconds(ms))

export interface TurnTimers {
  /** Call for every runtime event: this is what makes the idle clock start over. */
  touch(): void
  /**
   * Stop the idle clock without ending the turn. Used while Manor itself is
   * waiting (ask-user), so a five-minute silence does not kill a blocked CLI.
   */
  pause(): void
  /** Arm a fresh idle window after `pause`. A no-op if the turn is not paused. */
  resume(): void
  /**
   * Terminal, and the reason a settled turn stays settled: a stdout chunk that
   * arrives after the process closed would otherwise re-arm the idle clock through
   * `touch`, leaving a timer to fire a kill at a turn that is already over.
   */
  clear(): void
}

/**
 * Starts both clocks. `expire` is called at most once, with a message that says
 * which clock ran out, and is expected to kill the process and fail the turn.
 */
export function startTurnTimers(timeouts: TurnTimeouts, expire: (message: string) => void): TurnTimers {
  let idle: NodeJS.Timeout | undefined
  let spent = false
  let paused = false

  const fire = (message: string) => {
    if (spent) return
    spent = true
    clear()
    expire(message)
  }

  const clear = () => {
    // Spending the turn here, not only in `fire`, is what makes clearing terminal:
    // a late `touch` after the process closed must arm nothing.
    spent = true
    paused = false
    if (overall !== undefined) clearTimeout(overall)
    if (idle !== undefined) clearTimeout(idle)
  }

  // Zero is "no cap", not "fire now". `setTimeout(fn, 0)` would kill the turn
  // on the next tick, which is the opposite of what the default is for.
  const overall =
    timeouts.overallMs > 0
      ? setTimeout(
          () => fire(`the turn did not finish within ${inMinutes(timeouts.overallMs)}`),
          timeouts.overallMs,
        )
      : undefined
  overall?.unref?.()

  const touch = () => {
    if (spent || paused) return
    if (idle !== undefined) clearTimeout(idle)
    idle = setTimeout(() => fire(`the turn went quiet: no activity for ${inSeconds(timeouts.idleMs)}`), timeouts.idleMs)
    idle.unref?.()
  }

  const pause = () => {
    if (spent || paused) return
    paused = true
    if (idle !== undefined) clearTimeout(idle)
    idle = undefined
  }

  const resume = () => {
    if (spent || !paused) return
    paused = false
    touch()
  }

  touch()
  return { touch, pause, resume, clear }
}

const idleKey = (chatId: string, agentId: string) => `${chatId}\0${agentId}`

/**
 * Lets the ask-user wait pause the driver that is blocked on it, without the
 * broker importing a CLI or the driver importing the broker.
 */
export class TurnIdleGate {
  private readonly clocks = new Map<string, TurnTimers>()
  private readonly holds = new Map<string, number>()

  attach(chatId: string, agentId: string, timers: TurnTimers): () => void {
    const key = idleKey(chatId, agentId)
    this.clocks.set(key, timers)
    if ((this.holds.get(key) ?? 0) > 0) timers.pause()
    return () => {
      if (this.clocks.get(key) === timers) this.clocks.delete(key)
    }
  }

  hold(chatId: string, agentId: string): void {
    const key = idleKey(chatId, agentId)
    const next = (this.holds.get(key) ?? 0) + 1
    this.holds.set(key, next)
    if (next === 1) this.clocks.get(key)?.pause()
  }

  /** True while ask-user (or any other hold) is keeping this turn's clocks paused. */
  held(chatId: string, agentId: string): boolean {
    return (this.holds.get(idleKey(chatId, agentId)) ?? 0) > 0
  }

  release(chatId: string, agentId: string): void {
    const key = idleKey(chatId, agentId)
    const current = this.holds.get(key) ?? 0
    if (current <= 1) {
      this.holds.delete(key)
      if (current === 1) this.clocks.get(key)?.resume()
      return
    }
    this.holds.set(key, current - 1)
  }
}

/**
 * Pauses the idle clock while a named tool is in flight. A Jira or vault call
 * that writes nothing for five minutes is waiting, not hung. A stuck tool needs
 * Stop, the same as ask-user. Only `tool_use` lines with an id count, because
 * those are the ones a later `tool_result` can close. A result closes only its own
 * call: a background launch is released by its receipt and reports again when its
 * work ends, and that second result must not release some other running call.
 */
export function watchInFlightTools(timers: TurnTimers): {
  see: (event: { type: string; toolCallId?: string }) => void
  /** A tool is still open, so its pause stands. */
  busy: () => boolean
} {
  const open = new Set<string>()
  return {
    busy: () => open.size > 0,
    see(event) {
      if (event.toolCallId === undefined || event.toolCallId.length === 0) return
      if (event.type === 'tool_use') {
        if (open.has(event.toolCallId)) return
        open.add(event.toolCallId)
        if (open.size === 1) timers.pause()
        return
      }
      if (event.type === 'tool_result' && open.delete(event.toolCallId) && open.size === 0) timers.resume()
    },
  }
}

/** Attach a turn's clocks to the gate and detach them when the turn is cleared. */
export function bindIdleClock(
  gate: TurnIdleGate | undefined,
  chatId: string,
  agentId: string,
  timers: TurnTimers,
): TurnTimers {
  if (gate === undefined) return timers
  const detach = gate.attach(chatId, agentId, timers)
  return {
    ...timers,
    clear: () => {
      detach()
      timers.clear()
    },
  }
}
