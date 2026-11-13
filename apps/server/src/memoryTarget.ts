import path from 'node:path'

/**
 * Where memory lives on this machine, decided once at startup and printed. It names
 * the daily log folder; everything else in the memory folder is found from there.
 *
 * There used to be a second branch for a server without the folder, which had the
 * personas push new files to a repository instead. It existed for a hosted Manor that
 * was never built, and it made every prompt carry a choice. Memory is a local folder.
 */
export interface MemoryTarget {
  dailyDir: string
}

const pinnedMemoryDir = (env: NodeJS.ProcessEnv): string =>
  (env['MANOR_MEMORY_DIR'] ?? '').trim()

/** Whether the environment decides the memory folder, which Settings then cannot change. */
export const memoryDirPinned = (env: NodeJS.ProcessEnv): boolean => pinnedMemoryDir(env).length > 0

/** The folder inside the data directory where memory lives unless a setting points elsewhere. */
export const DEFAULT_MEMORY_FOLDER = 'memory'

const expand = (path: string, home: string): string =>
  path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path

/**
 * Where memory lives. `MANOR_MEMORY_DIR` names the folder. Without it, the folder
 * picked in Settings (`saved`) applies. Without that too, memory sits beside the database in
 * the data directory, so a new install has one folder to back up. Daily logs go under
 * `memory/daily` inside the folder.
 */
export function resolveMemoryTarget(env: NodeJS.ProcessEnv, home: string, saved: string | null = null): MemoryTarget {
  const configured = memoryDirPinned(env) ? pinnedMemoryDir(env) : (saved ?? '').trim()
  const dataDir = env['MANOR_DATA_DIR'] || `${home}/.manor`
  const root = configured.length > 0 ? configured : `${dataDir.replace(/\/+$/, '')}/${DEFAULT_MEMORY_FOLDER}`
  return { dailyDir: `${expand(root, home).replace(/\/+$/, '')}/memory/daily` }
}

/** One line at startup, so the folder in force is readable instead of inferred. */
export const memoryTargetNotice = (target: MemoryTarget): string =>
  `[manor] personas log to ${target.dailyDir}/YYYY-MM-DD.md`

/**
 * The memory folder itself, the one definition of "memory" for reads (the trace) and
 * writes (the footer's memory diff, which the changed-files banner leaves out).
 * Undefined only where a caller was given no memory at all, as some tests are.
 */
export function memoryRoot(target: MemoryTarget | undefined): string | undefined {
  return target === undefined ? undefined : path.resolve(target.dailyDir, '..', '..')
}

/** Per-persona standing notes, sibling of `memory/daily`. A missing file is the off state, Manor never creates one. */
export function agentNotesPath(target: MemoryTarget | undefined, agentId: string): string | undefined {
  if (target === undefined || agentId.length === 0) return undefined
  return path.resolve(target.dailyDir, '..', 'agents', `${agentId}.md`)
}
