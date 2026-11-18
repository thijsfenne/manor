import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EMBEDDED_DRIVER_ENV } from './embeddedDriver'

/**
 * The server this app carries inside itself, for a Mac where nothing else runs one.
 * A checkout started with `pnpm start`, or a LaunchAgent, already answers on the
 * usual port; then the app is only a window on it, as it always was. With nothing
 * there the app starts its own copy from `Resources/server` and stops it on quit.
 */

/** The port a Manor server on this Mac listens on unless told otherwise. */
export const SERVER_PORT = 43179
const PATH_MARK = '__MANOR_PATH__'

/** The bundled server's entry file, or null in a build that carries none (`pnpm dev`). */
export function bundledServerEntry(resourcesPath: string): string | null {
  const entry = path.join(resourcesPath, 'server', 'dist', 'main.mjs')
  return existsSync(entry) ? entry : null
}

/** Whether a Manor server already answers at this address. Anything else there is not ours. */
export async function manorAnswers(origin: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchFn(new URL('/health', origin), { signal: AbortSignal.timeout(1_500) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Waits until a Manor server answers at this address, or the time runs out. At login
 * the app can open before a LaunchAgent's server listens; its own copy then fails on
 * the database that server holds, and this finds the server it should have used.
 */
export async function waitForManor(origin: string, timeoutMs: number, fetchFn: typeof fetch = fetch, pauseMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (await manorAnswers(origin, fetchFn)) return true
    if (Date.now() + pauseMs > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, pauseMs))
  }
}

type RunShell =(shell: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>

const runShell: RunShell = (shell, args, env) => new Promise((resolve, reject) => {
  execFile(shell, args, { env, timeout: 5_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
    if (error !== null) reject(error)
    else resolve(stdout)
  })
})

/**
 * PATH as the user's terminal has it. An app opened from Finder gets the bare system
 * PATH, without Homebrew, nvm or `~/.local/bin`, so the provider CLIs and everything
 * they start (node, git, an MCP server through npx) would not be found. The login
 * shell is asked once; marks around the value keep a chatty profile out of it. Any
 * failure keeps the PATH the app was given, with the usual install folders added.
 */
export async function loginShellPath(env: NodeJS.ProcessEnv, home: string = os.homedir(), run: RunShell = runShell): Promise<string> {
  const given = env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin'
  const usual = [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const merged = (first: string) => [...new Set([...first.split(':'), ...given.split(':'), ...usual].filter((dir) => dir.startsWith('/')))].join(':')
  try {
    const shell = env['SHELL'] ?? '/bin/zsh'
    const out = await run(shell, ['-ilc', `printf '%s' "${PATH_MARK}$PATH${PATH_MARK}"`], env)
    const found = out.split(PATH_MARK)[1]
    return merged(found === undefined || found.trim() === '' ? '' : found.trim())
  } catch {
    return merged('')
  }
}

/** The usual port when it is free, so the window keeps one origin across launches; any free one otherwise. */
export function choosePort(preferred: number = SERVER_PORT): Promise<number> {
  const listen = (port: number) => new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(port, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
  return listen(preferred).catch(() => listen(0))
}

/** What the bundled server is started with. Everything else it decides itself, as from source. */
export function bundledServerEnv(options: {
  env: NodeJS.ProcessEnv
  home: string
  path: string
  port: number
  resourcesPath: string
  /** The embedded Cua driver and its daemon's socket; the server points the computer connector there. */
  computer?: { driver: string; socket: string }
}): NodeJS.ProcessEnv {
  return {
    ...options.env,
    ...(options.computer === undefined ? {} : {
      ...EMBEDDED_DRIVER_ENV,
      MANOR_CUA_DRIVER: options.computer.driver,
      MANOR_CUA_SOCKET: options.computer.socket,
    }),
    // The app's own binary runs the entry file as plain Node.
    ELECTRON_RUN_AS_NODE: '1',
    PATH: options.path,
    MANOR_HOST: '127.0.0.1',
    MANOR_PORT: String(options.port),
    MANOR_DATA_DIR: options.env['MANOR_DATA_DIR'] ?? path.join(options.home, '.manor'),
    MANOR_WEB_DIST: path.join(options.resourcesPath, 'web'),
    // The only server on this Mac, so scheduled tasks are its job.
    MANOR_ROUTINES: options.env['MANOR_ROUTINES'] ?? 'on',
  }
}

export interface BundledServer {
  origin: string
  child: ChildProcess
  stop(): void
}

/**
 * Starts the bundled server and resolves once it answers. Its output goes to the log
 * files Settings already lists. Rejects when it exits first or stays silent.
 */
export async function startBundledServer(options: {
  entry: string
  execPath: string
  resourcesPath: string
  env?: NodeJS.ProcessEnv
  home?: string
  timeoutMs?: number
  /** Tests name a port of their own, so they never take the one a real server uses. */
  port?: number
  computer?: { driver: string; socket: string }
}): Promise<BundledServer> {
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()
  const port = options.port ?? await choosePort()
  const logs = path.join(home, 'Library', 'Logs')
  mkdirSync(logs, { recursive: true })
  const child = spawn(options.execPath, [options.entry], {
    cwd: home,
    env: bundledServerEnv({
      env, home, path: await loginShellPath(env, home), port, resourcesPath: options.resourcesPath,
      ...(options.computer === undefined ? {} : { computer: options.computer }),
    }),
    stdio: ['ignore', openSync(path.join(logs, 'manor.log'), 'a'), openSync(path.join(logs, 'manor.err.log'), 'a')],
  })
  const origin = `http://localhost:${port}`
  let exited: number | null | undefined
  child.once('exit', (code) => { exited = code })
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`The Manor server stopped while starting (exit ${exited ?? 'signal'}). See ${path.join(logs, 'manor.err.log')}.`)
    if (await manorAnswers(origin)) return { origin, child, stop: () => { child.kill('SIGTERM') } }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  child.kill('SIGTERM')
  throw new Error(`The Manor server did not answer in time. See ${path.join(logs, 'manor.err.log')}.`)
}
