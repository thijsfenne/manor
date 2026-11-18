import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The Cua driver a release Manor.app carries in `Resources/cua-driver`. Main starts
 * its daemon as a direct child, so macOS answers every Accessibility and Screen
 * Recording check with Manor's own grants: one grant, held by an app whose Developer
 * ID signature stays the same across updates. A checkout and `pnpm desktop:package`
 * carry no driver and keep using CuaDriver.app.
 */

const HOST_BUNDLE_ID = 'com.thijsfenne.manor'
/** A daemon that dies sooner than this after starting counts as a failed start. */
const STEADY_MS = 10_000
const MAX_QUICK_FAILURES = 3
const RESPAWN_MS = 1_000
const KILL_AFTER_MS = 3_000

/** Set for the daemon and, through the bundled server, for every MCP proxy to it. */
export const EMBEDDED_DRIVER_ENV = {
  CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
  CUA_DRIVER_RS_UPDATE_CHECK: '0',
} as const

/** The driver inside this app, or null in a build without one. */
export function embeddedDriverPath(resourcesPath: string): string | null {
  const driver = path.join(resourcesPath, 'cua-driver', 'cua-driver')
  return existsSync(driver) ? driver : null
}

function embeddedDriverArgs(socket: string): string[] {
  return ['serve', '--embedded', '--socket', socket, '--host-bundle-id', HOST_BUNDLE_ID]
}

function embeddedDriverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ...EMBEDDED_DRIVER_ENV,
    CUA_DRIVER_EMBEDDED: '1',
    // EOF on stdin tells the daemon its host is gone, so a crashed Manor leaves no daemon.
    CUA_DRIVER_PARENT_LIVENESS_STDIN: '1',
  }
}

type Spawn = (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess

const spawnDaemon: Spawn = (command, args, env) => {
  const logs = path.join(os.homedir(), 'Library', 'Logs')
  mkdirSync(logs, { recursive: true })
  const log = openSync(path.join(logs, 'manor-cua-driver.log'), 'a')
  try {
    return spawn(command, args, { env, stdio: ['pipe', log, log] })
  } finally {
    // The child holds its own copy.
    closeSync(log)
  }
}

/**
 * One daemon on a private socket in a fresh 0700 folder. The daemon refuses to bind a
 * socket path that exists, so a restart removes the old one only after the old
 * process has gone. An unexpected exit is retried, a daemon that keeps dying right
 * after its start is given up on: the computer connector then fails with its own error.
 */
export class EmbeddedDriver {
  readonly socket: string
  private readonly folder: string
  private child: { process: ChildProcess; gone: Promise<void> } | null = null
  private startedAt = 0
  private quickFailures = 0
  private stopping = false
  private respawn: ReturnType<typeof setTimeout> | null = null
  private restarting: Promise<void> | null = null

  constructor(
    private readonly driver: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly spawnFn: Spawn = spawnDaemon,
  ) {
    this.folder = mkdtempSync(path.join(os.tmpdir(), 'manor-cua-'))
    this.socket = path.join(this.folder, 'driver.sock')
  }

  start(): void {
    if (this.stopping || this.child !== null) return
    this.startedAt = Date.now()
    let spawned: ChildProcess
    try {
      rmSync(this.socket, { force: true })
      spawned = this.spawnFn(this.driver, embeddedDriverArgs(this.socket), embeddedDriverEnv(this.env))
    } catch (error: unknown) {
      console.error('[manor] the embedded Cua driver did not start:', error instanceof Error ? error.message : error)
      this.ended()
      return
    }
    spawned.once('error', (error) => console.error('[manor] the embedded Cua driver did not start:', error.message))
    // `close` follows both an exit and a spawn that failed, which emits no `exit`.
    const gone = new Promise<void>((resolve) => spawned.once('close', () => resolve()))
    const child = { process: spawned, gone }
    this.child = child
    void gone.then(() => {
      if (this.child !== child) return
      this.child = null
      this.ended()
    })
  }

  /**
   * A fresh daemon after a grant changed: the running one keeps the negative Screen
   * Recording answer macOS cached in its process. Calls during a restart share it.
   */
  restart(): Promise<void> {
    this.restarting ??= this.recycle().finally(() => { this.restarting = null })
    return this.restarting
  }

  stop(): void {
    this.stopping = true
    if (this.respawn !== null) clearTimeout(this.respawn)
    this.child?.process.kill('SIGTERM')
    this.child = null
    rmSync(this.folder, { recursive: true, force: true })
  }

  private async recycle(): Promise<void> {
    const child = this.child
    this.child = null
    this.quickFailures = 0
    if (this.respawn !== null) clearTimeout(this.respawn)
    this.respawn = null
    if (child !== null) {
      child.process.kill('SIGTERM')
      const kill = setTimeout(() => child.process.kill('SIGKILL'), KILL_AFTER_MS)
      await child.gone
      clearTimeout(kill)
    }
    this.start()
  }

  private ended(): void {
    if (this.stopping) return
    this.quickFailures = Date.now() - this.startedAt < STEADY_MS ? this.quickFailures + 1 : 0
    if (this.quickFailures >= MAX_QUICK_FAILURES) {
      console.error('[manor] the embedded Cua driver keeps exiting; see ~/Library/Logs/manor-cua-driver.log')
      return
    }
    this.respawn = setTimeout(() => { this.respawn = null; this.start() }, RESPAWN_MS)
  }
}
