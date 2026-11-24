import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { readBuildInfo, SERVER_ROOT } from './serverRoot.js'
import { promisify } from 'node:util'
import { DriverSchema, type SystemInfo } from '@manor/contracts'
import { z } from 'zod'
import type { DriverSet } from './drivers/index.js'
import { gitBinary } from './gitBinary.js'

const execFileAsync = promisify(execFile)

/** The checkout this server runs from, the same one the desktop app is built out of. */
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..')

const LOGS = [
  { label: 'Server log', file: 'Library/Logs/manor.log' },
  { label: 'Server errors', file: 'Library/Logs/manor.err.log' },
  { label: 'Restart log', file: '.manor/logs/restart-when-idle.log' },
] as const

/** The log files present on this Mac; `reveal_log` only ever opens one of these. */
export async function listLogs(home: string): Promise<SystemInfo['logs']> {
  const found = await Promise.all(LOGS.map(async ({ label, file }) => {
    const logPath = path.join(home, file)
    const info = await stat(logPath).catch(() => undefined)
    return info?.isFile() === true ? { label, path: logPath } : undefined
  }))
  return found.filter((log) => log !== undefined)
}

const packageVersion = (relative: string): Promise<string | undefined> =>
  readFile(path.resolve(SERVER_ROOT, 'src', relative), 'utf8')
    .then((text) => z.object({ version: z.string() }).parse(JSON.parse(text)).version)
    .catch(() => undefined)

const gitCommit = (): Promise<string | null> =>
  execFileAsync(gitBinary(), ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, timeout: 5_000 })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null)

async function providerRuntimes(drivers: DriverSet['byProvider']): Promise<SystemInfo['providers']> {
  const real = DriverSchema.options.filter((driver) => driver !== 'mock')
  const described = await Promise.all(real.map(async (driver) => {
    const runtime = await drivers[driver]?.describeRuntime?.()
    return runtime === undefined ? undefined : { driver, ...runtime }
  }))
  return described.filter((provider) => provider !== undefined)
}

export interface SystemInfoSources {
  /** The memory folder; null where none was given. */
  memoryDir: string | null
  /** `MANOR_VAULT_DIR` as resolved at boot; null when unset or unusable. */
  vaultDir: string | null
  /** The real provider drivers; empty under `MANOR_DRIVER=mock`. */
  drivers: DriverSet['byProvider']
  home: string
  /** The keep awake controller can hold this Mac awake; false off macOS. */
  canKeepAwake?: boolean
  /** The .env file the server reads; only the path is ever sent. */
  envFile?: string
  /**
   * How each folder relates to its setting right now. Asked on every read, because
   * the setting changes in the app while the folder in use only changes at a start.
   */
  folders?: () => Promise<Record<'memory' | 'knowledge', FolderState>>
}

/**
 * `pinned`: an environment variable decides it. `pinnedIn`: the .env file that sets that
 * variable, absent when the launch environment does; only the path is ever sent.
 * `pending`: what the next start will use, when that differs.
 */
export interface FolderState {
  pinned: boolean
  pinnedIn?: string | undefined
  pending: string | null
}

const SETTLED: FolderState = { pinned: false, pending: null }

/**
 * Whether a variable pins a folder, and which .env file set that variable: `origin` is
 * where its value came from at startup (`envOrigin`), undefined meaning the data folder's
 * file. A value from the launch environment names no file, and neither does an unpinned folder.
 */
export function pinState(
  pinned: boolean,
  origin: 'environment' | 'checkout' | undefined,
  files: { checkout: string; data: string },
): Pick<FolderState, 'pinned' | 'pinnedIn'> {
  if (!pinned || origin === 'environment') return { pinned }
  return { pinned, pinnedIn: origin === 'checkout' ? files.checkout : files.data }
}

/**
 * Settings' About, Providers and Memory & vault. Versions and the commit cost a
 * process each, so they are asked once on first use and kept for the process; the
 * log list is checked on every read because a log appears when something first
 * writes it.
 */
export function createSystemInfo(sources: SystemInfoSources): () => Promise<SystemInfo> {
  const startedAt = new Date(performance.timeOrigin).toISOString()
  let fixed: Promise<Pick<SystemInfo, 'version' | 'commit' | 'providers'>> | undefined
  const readFixed = async () => {
    // A bundle has no checkout to ask; the build wrote down what it was made from.
    const built = readBuildInfo()
    if (built !== undefined) {
      return {
        version: built.version,
        commit: built.commit === 'unknown' ? null : built.commit.slice(0, 7),
        providers: await providerRuntimes(sources.drivers),
      }
    }
    const [desktop, commit, providers] = await Promise.all([
      packageVersion('../../desktop/package.json'),
      gitCommit(),
      providerRuntimes(sources.drivers),
    ])
    return { version: desktop ?? await packageVersion('../package.json') ?? 'unknown', commit, providers }
  }
  return async () => {
    fixed ??= readFixed()
    const folders = await sources.folders?.() ?? { memory: SETTLED, knowledge: SETTLED }
    return {
      ...await fixed,
      startedAt,
      memory: { path: sources.memoryDir, ...folders.memory },
      vault: { path: sources.vaultDir, ...folders.knowledge },
      logs: await listLogs(sources.home),
      canKeepAwake: sources.canKeepAwake === true,
      ...(sources.envFile === undefined ? {} : { envFile: sources.envFile }),
    }
  }
}
