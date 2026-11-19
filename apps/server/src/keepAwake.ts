import { spawn } from 'node:child_process'
import type { KeepAwakeMode } from '@manor/contracts'

/** Back to back turns of one chain end and start within this, so the hold does not flap. */
export const KEEP_AWAKE_GRACE_MS = 60_000
/** A child that dies on its own is replaced on a later sync, never sooner than this after it started. */
export const KEEP_AWAKE_RESPAWN_GAP_MS = 5_000

const CAFFEINATE = '/usr/bin/caffeinate'

/** The one process that holds the Mac awake, as the controller needs it. */
export interface KeepAwakeChild {
  kill: () => void
  /** Called once when the process exits, or fails to start with the error. */
  onEnd: (listener: (error?: Error) => void) => void
}

export interface KeepAwakeDeps {
  platform: NodeJS.Platform
  /** The server's own pid: the hold ends with this process, so a crash releases it. */
  pid: number
  spawn: (command: string, args: string[]) => KeepAwakeChild
  /** Runs `run` after `ms`, returning the cancel. */
  schedule: (run: () => void, ms: number) => () => void
  now: () => number
  warn: (message: string) => void
}

/**
 * Started with no shell, no inherited environment and no stdio. `-i` holds off idle
 * system sleep only, `-w` ends the hold when the server process ends.
 */
const spawnCaffeinate: KeepAwakeDeps['spawn'] = (command, args) => {
  const child = spawn(command, args, { stdio: 'ignore', env: {}, shell: false })
  child.unref()
  return {
    kill: () => { child.kill() },
    onEnd: (listener) => {
      let ended = false
      const end = (error?: Error) => {
        if (ended) return
        ended = true
        listener(error)
      }
      child.once('exit', () => { end() })
      child.once('error', (error) => { end(error) })
    },
  }
}

const liveDeps = (): KeepAwakeDeps => ({
  platform: process.platform,
  pid: process.pid,
  spawn: spawnCaffeinate,
  schedule: (run, ms) => {
    const timer = setTimeout(run, ms)
    timer.unref()
    return () => { clearTimeout(timer) }
  },
  now: Date.now,
  warn: (message) => { console.warn(message) },
})

/**
 * Holds the Mac awake per the `keepAwake` house setting. `main.ts` calls `sync` with
 * the saved mode and the running work count whenever either may have changed, and
 * `stop` at shutdown. Off macOS every call does nothing.
 */
export function createKeepAwake(overrides: Partial<KeepAwakeDeps> = {}) {
  const deps = { ...liveDeps(), ...overrides }
  const supported = deps.platform === 'darwin'
  let child: KeepAwakeChild | undefined
  let spawnedAt = Number.NEGATIVE_INFINITY
  let cancelRelease: (() => void) | undefined
  let stopped = false
  // A caffeinate that cannot start will not start on the next try either.
  let broken = false

  const clearRelease = () => {
    cancelRelease?.()
    cancelRelease = undefined
  }

  const release = () => {
    clearRelease()
    const held = child
    child = undefined
    // The gap is for a child that died on its own; one let go on purpose may come back at once.
    if (held !== undefined) spawnedAt = Number.NEGATIVE_INFINITY
    held?.kill()
  }

  const hold = () => {
    if (child !== undefined || broken || deps.now() - spawnedAt < KEEP_AWAKE_RESPAWN_GAP_MS) return
    spawnedAt = deps.now()
    let started: KeepAwakeChild
    try {
      started = deps.spawn(CAFFEINATE, ['-i', '-w', String(deps.pid)])
    } catch (error: unknown) {
      // Thrown at once, such as out of memory: a later sync past the gap tries again.
      deps.warn(`[manor] could not keep the Mac awake: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    child = started
    started.onEnd((error) => {
      if (child === started) child = undefined
      if (error === undefined) return
      broken = true
      deps.warn(`[manor] could not keep the Mac awake: ${error.message}`)
    })
  }

  return {
    /** Settings shows the keep awake choice only where this is true. */
    supported,
    sync(mode: KeepAwakeMode, work: number): void {
      if (!supported || stopped) return
      if (mode === 'always' || (mode === 'working' && work > 0)) {
        clearRelease()
        hold()
        return
      }
      if (mode === 'off' || child === undefined) {
        release()
        return
      }
      cancelRelease ??= deps.schedule(release, KEEP_AWAKE_GRACE_MS)
    },
    stop(): void {
      stopped = true
      release()
    },
  }
}

export type KeepAwake = ReturnType<typeof createKeepAwake>
