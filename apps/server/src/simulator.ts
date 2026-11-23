import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { SimulatorAction, SimulatorDevice, SimulatorState } from '@manor/contracts'
import { childProcessEnv } from './childEnv.js'

/**
 * The screen helper: serve-sim (Apache-2.0) captures a booted simulator's framebuffer
 * and takes touch and key input. Pinned with the registry's own integrity hashes and
 * installed on first use into Manor's tools folder, with `ws`, its one runtime
 * dependency. It runs on the server's own Node, never through npx, so a device opens
 * without the registry once it is installed. It loads private CoreSimulator frameworks
 * through a native addon; as a child process, a crash there cannot take the server down.
 */
export const SERVE_SIM_PACKAGES = [
  {
    name: 'serve-sim',
    version: '0.1.49',
    integrity: 'sha512-Q2SC29YDY30+qrfNA7Auv4etGqe++FYT3bionmpnKi3kd1xgisI/ohSyrrLqD9N5UsBMXjITcVecxMCQAV5sgg==',
  },
  {
    name: 'ws',
    version: '8.21.0',
    integrity: 'sha512-Vsp28b7DRcimFQvrqu2Wek3z1iYxDCWqHYB8Qsnk/S4RfaCQzPGPyBNuVjJV3cd6UiKtUtp6sNM77gWvzcCH+g==',
  },
] as const

const HUB_READY_MS = 30_000
const BOOT_WAIT_MS = 180_000
const SIMCTL_MS = 30_000

/** What `xcrun simctl list devices available -j` prints, as far as the panel reads it. */
interface SimctlList {
  devices?: Record<string, Array<{ udid?: unknown; name?: unknown; state?: unknown; isAvailable?: unknown }>>
}

/** The iOS simulators in a `simctl list -j` answer, booted ones first. Watch, TV and Vision runtimes are left out. */
export function parseSimctlDevices(json: string): SimulatorDevice[] {
  const parsed = JSON.parse(json) as SimctlList
  const devices: SimulatorDevice[] = []
  for (const [runtimeId, entries] of Object.entries(parsed.devices ?? {})) {
    const version = /SimRuntime\.iOS-(\d+)-(\d+)$/.exec(runtimeId)
    if (version === null || !Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry.udid !== 'string' || typeof entry.name !== 'string' || entry.isAvailable === false) continue
      devices.push({ udid: entry.udid, name: entry.name, runtime: `iOS ${version[1]}.${version[2]}`, booted: entry.state === 'Booted' })
    }
  }
  const major = (device: SimulatorDevice) => Number(device.runtime.slice(4).split('.')[0])
  return devices.sort((a, b) =>
    Number(b.booted) - Number(a.booted) || major(b) - major(a) || a.name.localeCompare(b.name))
}

export interface SimulatorDeps {
  platform: NodeJS.Platform
  arch: string
  /** Runs a command without a shell; rejects with the process's stderr on a non-zero exit. */
  run: (command: string, args: string[], timeoutMs: number) => Promise<string>
  /** Where the pinned helper is installed. */
  toolsDir: string
  /** Fetches one registry tarball. */
  download: (url: string) => Promise<Buffer>
  /** Starts the helper on a loopback port and resolves once it answers; `onExit` fires when it dies. */
  startHub: (entry: string, udid: string, onExit: () => void) => Promise<{ port: number; stop: () => void }>
  /** Asks the running helper to stream a device. */
  attach: (port: number, udid: string) => Promise<void>
}

export interface SimulatorHost {
  state(): SimulatorState
  /** One panel action; the new state goes to every client through `broadcast`. */
  handle(action: SimulatorAction, udid?: string): Promise<void>
  /** Follows the Settings toggle. Off stops the helper; the simulators keep running. */
  setEnabled(enabled: boolean): void
  /** The helper's loopback port while it runs, for the proxy. */
  hubPort(): number | undefined
  stop(): void
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim().split('\n')[0]!.slice(0, 300)

/**
 * The one simulator view on this Mac. Devices are listed, booted and powered off with
 * `xcrun simctl`; only watching a screen starts the helper, and the first watch
 * installs it. Actions run one at a time, so two panels cannot install twice.
 */
export function createSimulatorHost(options: {
  deps: SimulatorDeps
  broadcast: (state: SimulatorState) => void
  /** A fresh signed base path for the stream, from the proxy. */
  streamBase: () => string
}): SimulatorHost {
  const { deps } = options
  let enabled = false
  let state: SimulatorState = { status: 'off', devices: [] }
  let hub: { port: number; stop: () => void } | undefined
  let queue: Promise<void> = Promise.resolve()

  const publish = (next: SimulatorState) => {
    // Work that finishes after the toggle went off must not bring the state back.
    if (!enabled && next.status !== 'off') return
    state = next
    options.broadcast(state)
  }
  const update = (patch: Partial<SimulatorState>, drop: Array<'pending' | 'error' | 'stream' | 'detail'> = []) => {
    const next = { ...state, ...patch }
    for (const key of drop) delete next[key]
    publish(next)
  }

  const stopHub = () => {
    const running = hub
    hub = undefined
    running?.stop()
  }

  const entry = () => path.join(deps.toolsDir, 'serve-sim', SERVE_SIM_PACKAGES[0].version, 'node_modules', 'serve-sim', 'dist', 'serve-sim.js')

  const install = async () => {
    const root = path.join(deps.toolsDir, 'serve-sim', SERVE_SIM_PACKAGES[0].version)
    const partial = `${root}.partial-${process.pid}`
    await rm(partial, { recursive: true, force: true })
    try {
      for (const pkg of SERVE_SIM_PACKAGES) {
        const bytes = await deps.download(`https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`)
        const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
        if (digest !== pkg.integrity) throw new Error(`The download of ${pkg.name} ${pkg.version} did not match its pinned hash.`)
        const target = path.join(partial, 'node_modules', pkg.name)
        await mkdir(target, { recursive: true })
        const archive = path.join(partial, `${pkg.name}.tgz`)
        await writeFile(archive, bytes)
        await deps.run('/usr/bin/tar', ['-xzf', archive, '-C', target, '--strip-components=1'], SIMCTL_MS)
        await rm(archive)
      }
      // Another Manor on the same tools folder finished first: keep its copy.
      if (existsSync(entry())) {
        await rm(partial, { recursive: true, force: true })
        return
      }
      await rm(root, { recursive: true, force: true })
      await rename(partial, root)
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      throw error
    }
  }

  const unavailable = (): string | undefined => {
    if (deps.platform !== 'darwin') return 'The Simulator needs the Mac that runs Manor, with Xcode installed.'
    if (deps.arch !== 'arm64') return 'The Simulator screen needs a Mac with Apple silicon.'
    return undefined
  }

  const list = async () => {
    const missing = unavailable()
    if (missing !== undefined) return publish({ status: 'unavailable', detail: missing, devices: [] })
    try {
      const devices = parseSimctlDevices(await deps.run('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '-j'], SIMCTL_MS))
      const stream = state.stream !== undefined && devices.some((device) => device.udid === state.stream?.udid && device.booted) ? state.stream : undefined
      if (stream === undefined && state.stream !== undefined) stopHub()
      update({ status: 'ready', devices, ...(stream === undefined ? {} : { stream }) }, stream === undefined ? ['detail', 'stream'] : ['detail'])
      return devices
    } catch (error) {
      publish({
        status: 'unavailable',
        detail: `Xcode's simulator tools did not answer (${errorText(error)}). Install Xcode, open it once to finish setup, then try again.`,
        devices: [],
      })
      return undefined
    }
  }

  const watch = async (udid: string) => {
    const devices = await list()
    if (devices === undefined) return
    if (!devices.some((device) => device.udid === udid && device.booted)) {
      update({ error: 'Start this simulator first.' })
      return
    }
    try {
      if (!existsSync(entry())) {
        update({ pending: { udid, step: 'installing' } }, ['error'])
        await install()
      }
      // Turned off while the helper downloaded: start nothing.
      if (!enabled) return
      update({ pending: { udid, step: 'starting' } }, ['error'])
      if (hub === undefined) {
        const started = await deps.startHub(entry(), udid, () => {
          if (hub !== started) return
          hub = undefined
          update({ error: 'The simulator screen stopped. Choose the device to watch it again.' }, ['stream'])
        })
        if (!enabled) {
          started.stop()
          return
        }
        hub = started
      }
      await deps.attach(hub.port, udid)
      update({ stream: { udid, base: options.streamBase() } }, ['pending', 'error'])
    } catch (error) {
      update({ error: `The simulator screen could not start: ${errorText(error)}` }, ['pending'])
    }
  }

  const boot = async (udid: string) => {
    update({ pending: { udid, step: 'booting' } }, ['error'])
    try {
      // An already booted device makes `boot` fail, which `bootstatus` then answers for.
      await deps.run('/usr/bin/xcrun', ['simctl', 'boot', udid], SIMCTL_MS).catch(() => undefined)
      await deps.run('/usr/bin/xcrun', ['simctl', 'bootstatus', udid], BOOT_WAIT_MS)
    } catch (error) {
      update({ error: `The simulator did not start: ${errorText(error)}` }, ['pending'])
      await list()
      return
    }
    await watch(udid)
  }

  const shutdown = async (udid: string) => {
    try {
      await deps.run('/usr/bin/xcrun', ['simctl', 'shutdown', udid], SIMCTL_MS)
    } catch (error) {
      update({ error: `The simulator did not power off: ${errorText(error)}` })
    }
    await list()
  }

  return {
    state: () => state,
    handle(action, udid) {
      const run = async () => {
        if (!enabled) return publish({ status: 'off', devices: [] })
        if (action === 'list') {
          await list()
          return
        }
        if (udid === undefined) return update({ error: 'Choose a simulator first.' })
        if (action === 'watch') return watch(udid)
        // Only a device from the last iOS listing is started or turned off; watch lists afresh itself.
        if (!state.devices.some((device) => device.udid === udid)) return update({ error: 'Choose a simulator from the list.' })
        if (action === 'boot') return boot(udid)
        return shutdown(udid)
      }
      const next = queue.then(run, run)
      queue = next.catch(() => undefined)
      return next
    },
    setEnabled(next) {
      if (next === enabled) return
      enabled = next
      if (!enabled) {
        stopHub()
        publish({ status: 'off', devices: [] })
      }
    },
    hubPort: () => hub?.port,
    stop: stopHub,
  }
}

/** A free loopback port, taken and released at once so the helper can bind it. */
async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port)
        else reject(new Error('No loopback port was free.'))
      })
    })
  })
}

/** An Xcode picked with `DEVELOPER_DIR` instead of `xcode-select` must stay the one simctl uses. */
const XCODE_KEYS = ['DEVELOPER_DIR']

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The real host: simctl, the registry and the helper as a child of the server's own Node. */
export function liveSimulatorDeps(env: NodeJS.ProcessEnv = process.env): SimulatorDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    run: (command, args, timeoutMs) =>
      new Promise((resolve, reject) => {
        execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: childProcessEnv(env, XCODE_KEYS) }, (error, stdout, stderr) => {
          if (error === null) resolve(stdout)
          else reject(new Error(stderr.trim() || error.message))
        })
      }),
    toolsDir: env.MANOR_TOOLS_DIR?.trim() || path.join(os.homedir(), '.manor', 'tools'),
    download: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`The helper download failed (${response.status}).`)
      return Buffer.from(await response.arrayBuffer())
    },
    startHub: async (entry, udid, onExit) => {
      const port = await freeLoopbackPort()
      // The packaged app runs this server as Electron in Node mode; the helper needs the same.
      const child = spawn(process.execPath, [entry, udid, '--port', String(port), '--host', '127.0.0.1'], {
        env: childProcessEnv(env, XCODE_KEYS, env.ELECTRON_RUN_AS_NODE === undefined ? {} : { ELECTRON_RUN_AS_NODE: env.ELECTRON_RUN_AS_NODE }),
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
      })
      let tail = ''
      child.stderr?.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2_000) })
      let exited = false
      // The helper never outlives the server, even when it quits mid-start.
      const stop = () => { if (!exited) child.kill('SIGTERM') }
      process.once('exit', stop)
      child.once('exit', () => {
        exited = true
        process.off('exit', stop)
        onExit()
      })
      child.once('error', () => { exited = true })
      const deadline = Date.now() + HUB_READY_MS
      while (Date.now() < deadline) {
        if (exited) throw new Error(tail.trim().split('\n').pop() || 'the helper exited at start')
        const ready = await fetch(`http://127.0.0.1:${port}/api`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false)
        if (ready) return { port, stop }
        await sleep(250)
      }
      stop()
      throw new Error('the helper did not answer in time')
    },
    attach: async (port, udid) => {
      const response = await fetch(`http://127.0.0.1:${port}/grid/api/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ udid }),
        signal: AbortSignal.timeout(BOOT_WAIT_MS),
      })
      const answer = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null
      if (!response.ok || answer?.ok !== true) throw new Error(answer?.error ?? `the helper refused the device (${response.status})`)
    },
  }
}
