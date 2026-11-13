import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

/**
 * The command every server git spawn runs. On a Mac without Homebrew git, `git` is
 * /usr/bin/git, an xcrun shim that looks up the developer directory on every run:
 * about 10.8 ms per spawn against 6 ms for the git behind it. Only the shim is swapped,
 * so a git earlier on PATH still wins. PATH itself is never changed, because providers,
 * terminals and git's own children share it. Any failure keeps plain `git`.
 */
const SHIM = '/usr/bin/git'
/** A failed lookup is not repeated on every spawn. */
const FAILURE_TTL_MS = 30_000

export interface GitBinaryHost {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  now: () => number
  isFile: (file: string) => boolean
  /** What `xcrun --find git` prints, or undefined when it fails. */
  xcrunFindGit: (env: NodeJS.ProcessEnv) => string | undefined
}

const realHost: GitBinaryHost = {
  platform: process.platform,
  get env() { return process.env },
  now: () => Date.now(),
  isFile: (file) => {
    try { return statSync(file).isFile() } catch { return false }
  },
  xcrunFindGit: (env) => {
    try {
      return execFileSync('/usr/bin/xcrun', ['--find', 'git'], {
        encoding: 'utf8', env, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return undefined
    }
  },
}

export function createGitBinary(host: GitBinaryHost): () => string {
  let cache: { key: string; command: string; at: number } | undefined
  const resolve = (): string => {
    const { env } = host
    // Empty and relative entries depend on each child's working directory, so they are skipped:
    // a dev server started through pnpm or tsx carries `./node_modules/.bin`, and it must not
    // switch the swap off.
    const first = (env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir))
      .map((dir) => path.join(dir, 'git')).find((candidate) => host.isFile(candidate))
    if (first !== SHIM) return 'git'
    const located = host.xcrunFindGit(env)
    return located !== undefined && path.isAbsolute(located) && host.isFile(located) ? located : 'git'
  }
  return () => {
    if (host.platform !== 'darwin') return 'git'
    const key = `${host.env.PATH ?? ''}\0${host.env.DEVELOPER_DIR ?? ''}`
    const now = host.now()
    // An Xcode update or removal deletes the resolved binary; look again instead of failing the spawn.
    const usable = cache?.key === key && (cache.command === 'git' ? now - cache.at < FAILURE_TTL_MS : host.isFile(cache.command))
    if (!usable) cache = { key, command: resolve(), at: now }
    return cache?.command ?? 'git'
  }
}

export const gitBinary = createGitBinary(realHost)
