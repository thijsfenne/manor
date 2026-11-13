import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { z } from 'zod'
import { childProcessEnv } from '../childEnv.js'
import { checkCodexProtocol } from './codexProtocol.js'
import { compareVersions } from './providerUpdate.js'

/**
 * The Codex CLI Manor runs, kept outside the repo under `<root>/<version>/` with
 * `<root>/active.json` naming the one every spawn uses. A release is downloaded
 * from GitHub, checked against its SHA-256, unpacked in a staging folder and
 * renamed into place; the pointer moves only after Manor's protocol check passes,
 * so a failed or timed-out update leaves the old version running. The previous
 * version stays on disk, so a rollback is pointing `active.json` back at it.
 * Nothing deletes a release that may still be in use: older ones go only a week
 * after they were last active, which also covers a second Manor process.
 */

export interface CodexRelease {
  version: string
  sha256: string
  bytes: number
}

export type InstallResult = { ok: true; version: string } | { ok: false; reason: string }
type CheckResult = { ok: true } | { ok: false; reason: string }

const TARGET = 'aarch64-apple-darwin'
const ASSET = `codex-package-${TARGET}.tar.gz`
const RELEASES_API = 'https://api.github.com/repos/openai/codex/releases/latest'

/**
 * What a fresh Manor installs, and the oldest release it runs: an older active
 * version is replaced by this one before the next spawn. Bump all three together,
 * from the release's `codex-package-aarch64-apple-darwin.tar.gz` asset.
 */
export const CODEX_PINNED: CodexRelease = {
  version: '0.164.0',
  sha256: 'dd99e9092270691a67bdde7be04ac283dea9da8e86cbde356c2cc851a79205fa',
  bytes: 136_007_998,
}

const VERSION = /^\d+\.\d+\.\d+$/
/** Writes below a staging folder do not refresh its mtime, so only a day-old one is abandoned. */
const STAGING_STALE_MS = 24 * 60 * 60_000
/**
 * How long a release stays on disk after it stopped being active or previous. A
 * Codex process spawned from it, possibly by another Manor process sharing the
 * folder, may still run its helpers from there.
 */
const RETIRED_KEEP_MS = 7 * 24 * 60 * 60_000
const LOCK_STALE_MS = 60_000
const INSTALL_TIMEOUT_MS = 15 * 60_000
const RUN_TIMEOUT_MS = 30_000
const API_TIMEOUT_MS = 5_000
const MAX_ENTRIES = 10_000

const releaseUrl = (version: string) => `https://github.com/openai/codex/releases/download/rust-v${version}/${ASSET}`

const ActiveSchema = z.object({ version: z.string().regex(VERSION), previous: z.string().regex(VERSION).optional() })
const RecordSchema = z.object({ version: z.string(), target: z.string(), sha256: z.string() })
const PackageSchema = z.object({ version: z.string(), target: z.string(), entrypoint: z.string() })
const LatestSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), size: z.number(), digest: z.string().nullable().optional() })),
})

/** The newest stable release with a darwin-arm64 package and a published digest, or null. */
export async function latestCodexRelease(fetchFn: typeof fetch = fetch): Promise<CodexRelease | null> {
  try {
    const response = await fetchFn(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const parsed = LatestSchema.safeParse(await response.json())
    if (!parsed.success) return null
    const version = /^rust-v(\d+\.\d+\.\d+)$/.exec(parsed.data.tag_name)?.[1]
    const asset = parsed.data.assets.find((item) => item.name === ASSET)
    const sha256 = asset?.digest == null ? undefined : /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1]
    if (version === undefined || asset === undefined || sha256 === undefined) return null
    return { version, sha256, bytes: asset.size }
  } catch {
    return null
  }
}

export interface ActiveCodex {
  version: string
  previous?: string
  /** Absolute path of the native binary. */
  command: string
}

export interface CodexInstallationOptions {
  /** `~/.manor/tools/codex` in production; tests use a temp folder. */
  root: string
  pinned?: CodexRelease
  fetchFn?: typeof fetch
  latest?: () => Promise<CodexRelease | null>
  /** Manor's protocol check, run against a release before it becomes active. */
  check?: (command: string) => Promise<CheckResult>
  /** Bounds a whole install, download through check. */
  timeoutMs?: number
  now?: () => number
}

class InstallError extends Error {}

export class CodexInstallation {
  private readonly root: string
  private readonly pinned: CodexRelease
  private readonly fetchFn: typeof fetch
  private readonly latest: () => Promise<CodexRelease | null>
  private readonly check: (command: string) => Promise<CheckResult>
  private readonly timeoutMs: number
  private readonly now: () => number
  /** One install at a time in this process; renames keep a second process safe. */
  private queue: Promise<unknown> = Promise.resolve()
  private pinnedInstall?: Promise<InstallResult>

  constructor(options: CodexInstallationOptions) {
    this.root = options.root
    this.pinned = options.pinned ?? CODEX_PINNED
    this.fetchFn = options.fetchFn ?? fetch
    this.latest = options.latest ?? (() => latestCodexRelease(this.fetchFn))
    this.check = options.check ?? checkCodexProtocol
    this.timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
    this.now = options.now ?? Date.now
  }

  /** The active binary, or null when none is installed or it is older than the pinned release. */
  async active(): Promise<ActiveCodex | null> {
    const pointer = await readJson(path.join(this.root, 'active.json'), ActiveSchema)
    if (pointer === null || compareVersions(pointer.version, this.pinned.version) < 0) return null
    if ((await this.installed(pointer.version)) === null) return null
    return { ...pointer, command: this.binary(pointer.version) }
  }

  /** The binary to spawn, installing the pinned release first when there is none. */
  async ensure(): Promise<string> {
    const current = await this.active()
    if (current !== null) return current.command
    const result = await this.installPinned()
    if (!result.ok) throw new Error(result.reason)
    const installed = await this.active()
    if (installed === null) throw new Error(`Codex ${result.version} was installed but is not active.`)
    return installed.command
  }

  /**
   * Starts the pinned install when nothing usable is active, so Manor can show it
   * before a turn waits on it. Null when a usable release is already active.
   */
  async prepare(): Promise<{ version: string; done: Promise<InstallResult> } | null> {
    if ((await this.active()) !== null) return null
    return { version: this.pinned.version, done: this.installPinned() }
  }

  /** Installs the newest release and makes it active once it passes the protocol check. */
  update(): Promise<InstallResult> {
    return this.exclusive(async () => {
      const release = await this.latest()
      if (release === null) return { ok: false, reason: 'Could not read the newest Codex release from GitHub.' }
      return this.activate(release)
    })
  }

  /** Removes staging folders a crashed install left behind a day or more ago. */
  async cleanStaging(): Promise<void> {
    const entries = await readdir(this.root).catch(() => [] as string[])
    await Promise.all(entries.filter((entry) => entry.startsWith('.install-') || entry.startsWith('.active-')).map(async (entry) => {
      const target = path.join(this.root, entry)
      const info = await stat(target).catch(() => null)
      if (info !== null && this.now() - info.mtimeMs >= STAGING_STALE_MS) await rm(target, { recursive: true, force: true }).catch(() => undefined)
    }))
  }

  private installPinned(): Promise<InstallResult> {
    this.pinnedInstall ??= this.exclusive(async () => {
      // An install queued ahead of this one may already have left a usable release.
      const current = await this.active()
      return current === null ? this.activate(this.pinned) : { ok: true as const, version: current.version }
    }).finally(() => { this.pinnedInstall = undefined })
    return this.pinnedInstall
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private binary(version: string): string {
    return path.join(this.root, version, 'bin', 'codex')
  }

  /** The completion record of an installed release, or null when the folder is not a finished install. */
  private async installed(version: string): Promise<z.infer<typeof RecordSchema> | null> {
    const record = await readJson(path.join(this.root, version, '.install-complete.json'), RecordSchema)
    if (record?.version !== version) return null
    return (await isExecutable(this.binary(version))) ? record : null
  }

  private async activate(release: CodexRelease): Promise<InstallResult> {
    if (!VERSION.test(release.version)) return { ok: false, reason: `Codex ${release.version} is not a release version.` }
    const before = await readJson(path.join(this.root, 'active.json'), ActiveSchema)
    const deadline = AbortSignal.timeout(this.timeoutMs)
    try {
      await mkdir(this.root, { recursive: true })
      await this.cleanStaging()
      const existing = await this.locked(async () => {
        const found = await this.installed(release.version)
        // A cached release restarts its retirement clock, so no prune deletes it mid-check.
        if (found !== null) await utimes(path.join(this.root, release.version), new Date(this.now()), new Date(this.now()))
        return found
      })
      if (existing !== null && existing.sha256 !== release.sha256) {
        throw new InstallError(`the installed ${release.version} differs from the official package`)
      }
      if (existing === null) await this.download(release, deadline)
      const checked = await this.check(this.binary(release.version))
      if (!checked.ok) throw new InstallError(`fails Manor's protocol check: ${checked.reason}`)
      if (deadline.aborted) throw new InstallError('timed out')
      const previous = before !== null && before.version !== release.version ? before.version : before?.previous
      await this.point({ version: release.version, ...(previous === undefined ? {} : { previous }) })
      // The release that just stopped being active starts its retirement clock now.
      if (before !== null && before.version !== release.version) {
        const now = new Date(this.now())
        await utimes(path.join(this.root, before.version), now, now).catch(() => undefined)
      }
      await this.prune()
      return { ok: true, version: release.version }
    } catch (error: unknown) {
      // A rejected release stays until it retires: another process may have activated it.
      const reason = deadline.aborted ? 'timed out' : error instanceof InstallError ? error.message : 'could not be written to disk'
      const kept = before === null ? '' : `, kept ${before.version}`
      return { ok: false, reason: `Codex ${release.version} ${reason}${kept}.` }
    }
  }

  /** Download, verify and unpack into staging, then rename into place. */
  private async download(release: CodexRelease, signal: AbortSignal): Promise<void> {
    const staging = await mkdtemp(path.join(this.root, '.install-'))
    try {
      const archive = path.join(staging, 'download.tar.gz')
      const runtime = path.join(staging, 'runtime')
      const response = await this.fetchFn(releaseUrl(release.version), { signal }).catch(() => null)
      if (response === null || !response.ok || response.body === null) throw new InstallError('could not be downloaded')
      const hash = createHash('sha256')
      let bytes = 0
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (bytes > release.bytes) return callback(new InstallError('is larger than the published package'))
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), counted, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal })
        .catch((error: unknown) => { throw error instanceof InstallError ? error : new InstallError('download was interrupted') })
      if (bytes !== release.bytes || hash.digest('hex') !== release.sha256) throw new InstallError('failed its SHA-256 check')
      await assertSafeArchive(archive)
      await mkdir(runtime)
      await run('tar', ['-xzf', archive, '-C', runtime]).catch(() => { throw new InstallError('could not be unpacked') })
      await assertPackage(runtime, release.version)
      await writeFile(path.join(runtime, '.install-complete.json'), JSON.stringify({ version: release.version, target: TARGET, sha256: release.sha256 }), { flag: 'wx', mode: 0o600 })
      await rename(runtime, path.join(this.root, release.version)).catch(async (error: unknown) => {
        // Another Manor process placed the same release first; theirs is as good as ours.
        if ((await this.installed(release.version))?.sha256 !== release.sha256) throw error
      })
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Atomic: a temp file renamed over the pointer, so a reader sees the old or the new one. */
  private async point(active: z.infer<typeof ActiveSchema>): Promise<void> {
    const temporary = path.join(this.root, `.active-${randomUUID()}.json`)
    await writeFile(temporary, JSON.stringify(active), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path.join(this.root, 'active.json'))
  }

  /**
   * Removes releases that are neither active nor previous and retired a week ago.
   * Locked against the cached-release refresh in `activate`, which may be another process's.
   */
  private prune(): Promise<void> {
    return this.locked(async () => {
      // Read now, not from this install: another process may have moved the pointer since.
      const pointer = await readJson(path.join(this.root, 'active.json'), ActiveSchema)
      if (pointer === null) return
      const keep = [pointer.version, pointer.previous]
      const entries = await readdir(this.root).catch(() => [] as string[])
      await Promise.all(entries.filter((entry) => VERSION.test(entry) && !keep.includes(entry)).map(async (entry) => {
        const target = path.join(this.root, entry)
        const info = await stat(target).catch(() => null)
        if (info !== null && this.now() - info.mtimeMs >= RETIRED_KEEP_MS) await rm(target, { recursive: true, force: true }).catch(() => undefined)
      }))
    })
  }

  /**
   * A short critical section shared by every Manor process on this folder. Held for
   * file metadata work only, never a download or a check, so a lock a minute old
   * was left by a crash.
   */
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const lock = path.join(this.root, '.lock')
    for (;;) {
      try {
        await mkdir(lock)
        break
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const info = await stat(lock).catch(() => null)
        if (info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true })
        else await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    try {
      return await work()
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  }
}

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > 4_096) return null
    const parsed = schema.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function isExecutable(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null)
  return info !== null && info.isFile() && info.size > 0 && (info.mode & 0o111) !== 0
}

/** Plain files and folders under relative paths only: no links, no `..`, no absolute names. */
async function assertSafeArchive(archive: string): Promise<void> {
  const [names, long] = await Promise.all([run('tar', ['-tzf', archive]), run('tar', ['-tvzf', archive])])
    .catch(() => { throw new InstallError('could not be read as an archive') })
  const entries = names.trim().split('\n')
  const kinds = long.trim().split('\n')
  const unsafe = entries.length > MAX_ENTRIES || entries.length !== kinds.length ||
    kinds.some((line) => line[0] !== '-' && line[0] !== 'd') ||
    entries.some((entry) => entry === '' || entry.startsWith('/') || entry.includes('\\') ||
      entry.replace(/\/$/, '').split('/').some((part) => part === '' || part === '.' || part === '..'))
  if (unsafe) throw new InstallError('contains unsafe archive entries')
}

/** The unpacked package is this release for this Mac, with the helpers the CLI runs beside it. */
async function assertPackage(directory: string, version: string): Promise<void> {
  const manifest = await readJson(path.join(directory, 'codex-package.json'), PackageSchema)
  if (manifest?.version !== version || manifest.target !== TARGET || manifest.entrypoint !== 'bin/codex') {
    throw new InstallError('does not match the expected package')
  }
  for (const name of ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg']) {
    if (!(await isExecutable(path.join(directory, name)))) throw new InstallError('is missing part of its package')
  }
  const output = await run(path.join(directory, 'bin', 'codex'), ['--version']).catch(() => null)
  if (output?.trim() !== `codex-cli ${version}`) throw new InstallError('does not start')
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // SIGKILL: a child that ignores SIGTERM would otherwise outlive its timeout.
    execFile(command, args, { timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: childProcessEnv() }, (error, stdout) => {
      if (error === null) resolve(String(stdout))
      else reject(error)
    })
  })
}
