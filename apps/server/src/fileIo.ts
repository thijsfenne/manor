import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, realpath, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { MAX_REPO_FILE_BYTES } from '@manor/contracts'

/**
 * Reading and writing one text file on the machine Manor runs on, for the two
 * places that do it: the vault and a project's linked folders.
 *
 * Only the mechanics live here. Which paths are allowed is the caller's question and
 * the two answer it differently — the vault vets a path by its own rules so a note
 * can be created before it exists, a linked folder vets it by membership of the
 * `git ls-files` listing. Neither guard would be safe applied to the other's paths,
 * so neither is in this file.
 */

export type TextRead =
  | { kind: 'ready'; content: string; revision: string }
  | { kind: 'too_large'; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'missing' }

/**
 * One text file, with the content hash a later write sends back as its precondition.
 *
 * Bounded twice on purpose: `stat` refuses the obvious case, and the read itself
 * takes one byte past the cap, so a file that grows in between still cannot put an
 * unbounded allocation or payload on the wire.
 */
export async function readTextFile(target: string): Promise<TextRead> {
  let handle
  try {
    // O_NOFOLLOW refuses a symlink rather than letting a vetted path become a read
    // somewhere else entirely.
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile()) return { kind: 'missing' }
    if (info.size > MAX_REPO_FILE_BYTES) return { kind: 'too_large', size: info.size }

    const buffer = Buffer.alloc(MAX_REPO_FILE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_REPO_FILE_BYTES) return { kind: 'too_large', size: bytesRead }
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) return { kind: 'binary', size: info.size }

    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return { kind: 'ready', content, revision: hashBytes(bytes) }
    } catch {
      return { kind: 'binary', size: info.size }
    }
  } catch {
    return { kind: 'missing' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export type TextReplace =
  | { kind: 'saved'; revision: string }
  | { kind: 'stale'; revision: string; content: string }
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'failed' }

/**
 * Replaces an existing text file, but only if it still holds `baseRevision`.
 *
 * The revision check and the replacement run as one step per file: two saves made
 * from the same revision are serialized, so the second sees the first's content and
 * comes back `stale` instead of silently winning. That covers Manor's own saves; an
 * external editor writing in between is still caught by the revision check, not
 * prevented. Missing and non-text files are never overwritten.
 */
export function replaceTextFile(target: string, bytes: Buffer, baseRevision: string): Promise<TextReplace> {
  return serializedPerFile(target, async () => {
    const current = await readTextFile(target)
    if (current.kind === 'missing') return { kind: 'missing' }
    if (current.kind !== 'ready') return { kind: 'unreadable' }
    if (current.revision !== baseRevision) {
      return { kind: 'stale', revision: current.revision, content: current.content }
    }
    return (await writeReplacing(target, bytes))
      ? { kind: 'saved', revision: hashBytes(bytes) }
      : { kind: 'failed' }
  })
}

/** Per real file path, the tail of its chain of saves, renames and moves. */
const saving = new Map<string, Promise<unknown>>()
/** Per real folder path, the tail of a folder move that holds every write under it. */
const holding = new Map<string, Promise<unknown>>()

const isUnder = (folder: string, key: string) => key.startsWith(folder + path.sep)

/** Chains `run` after `waits`, records its settled tail under `key`, and drops it when nothing newer queued. */
async function chained<T>(map: Map<string, Promise<unknown>>, key: string, waits: Promise<unknown>[], run: () => Promise<T>): Promise<T> {
  const current = Promise.all(waits).then(run, run)
  const settled = current.catch(() => undefined)
  map.set(key, settled)
  try {
    return await current
  } finally {
    if (map.get(key) === settled) map.delete(key)
  }
}

/** One write at a time per file, and none while a folder above it is moving. */
async function serializedPerFile<T>(target: string, run: () => Promise<T>): Promise<T> {
  const key = await realpath(target).catch(() => path.resolve(target))
  // Synchronous from here to the registration, so a folder move that starts later sees this write.
  const waits = [...holding].filter(([folder]) => isUnder(folder, key)).map(([, tail]) => tail)
  const previous = saving.get(key)
  if (previous !== undefined) waits.push(previous)
  return chained(saving, key, waits, run)
}

/**
 * Runs a folder move once every save, rename and move of a file under `folder` has
 * settled, and holds new ones until it is done. Saves are serialised per file, so
 * without this a save could write its temporary file into the folder, the folder could
 * move, and the save's rename and cleanup would both miss, leaving a hidden copy of the
 * note behind. Unrelated files never wait.
 */
export async function serializedPerFolder<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const key = await realpath(folder).catch(() => path.resolve(folder))
  const waits = [
    ...[...saving].filter(([file]) => isUnder(key, file)),
    ...[...holding].filter(([other]) => other === key || isUnder(other, key) || isUnder(key, other)),
  ].map(([, tail]) => tail)
  return chained(holding, key, waits, run)
}

/**
 * Overwrites a file all at once, or not at all, keeping its permission bits.
 *
 * Written beside the target and renamed over it, because rename is only atomic
 * within one filesystem and that is what makes the save all-or-nothing: no reader
 * ever sees a half-written file. Dot-prefixed so Obsidian ignores it and so a
 * `git status` run mid-save shows nothing worth reading. The temporary name is
 * unique and opened exclusively without following links, so a planted symlink or a
 * concurrent save can never redirect or clobber it. Ownership and ACLs are not
 * carried over; for a single-user checkout they already match the process.
 */
async function writeReplacing(target: string, bytes: Buffer): Promise<boolean> {
  const temporary = path.join(
    path.dirname(target),
    `.manor-${randomBytes(12).toString('hex')}.tmp`,
  )
  let handle
  let owned = false
  try {
    const mode = (await lstat(target)).mode & 0o7777
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    owned = true
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await handle.sync()
    await rename(temporary, target)
    owned = false
    return true
  } catch {
    // Emptied through the open handle first, so even if the folder moved away and the
    // removal by path below misses, no hidden copy of the note's text is left to sync.
    if (owned) await handle?.truncate(0).catch(() => undefined)
    return false
  } finally {
    await handle?.close().catch(() => undefined)
    if (owned) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export const hashBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export type TextMove = 'moved' | 'exists' | 'missing' | 'failed'

/** The filesystem calls a move makes, injectable so a test can fail one partway. */
export interface MoveFs { link: typeof link; unlink: typeof unlink; rename: typeof rename }
export const realMoveFs: MoveFs = { link, unlink, rename }

/**
 * Moves one file to a path that must not exist yet, serialized with saves of the source,
 * so a save sent before the move lands in the file that moves and a save sent after it
 * finds the old path gone instead of recreating it. Link then unlink, because link is
 * exclusive where rename silently replaces its destination. No copy is ever made.
 */
export function moveTextFile(source: string, destination: string, fs: MoveFs = realMoveFs): Promise<TextMove> {
  return serializedPerFile(source, async () => {
    const original = await lstat(source).catch(() => null)
    if (original === null || !original.isFile()) return 'missing'
    try {
      await fs.link(source, destination)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed'
    }
    try {
      const beforeRemove = await lstat(source)
      if (beforeRemove.ino !== original.ino || beforeRemove.dev !== original.dev) throw new Error('Source changed during move')
      await fs.unlink(source)
      return 'moved'
    } catch {
      const target = await lstat(destination).catch(() => null)
      if (target?.ino === original.ino && target.dev === original.dev) await unlink(destination).catch(() => undefined)
      return 'failed'
    }
  })
}

/** Rename without overwriting another note, serialized with saves of the source. */
export function renameTextFile(source: string, destination: string, baseRevision: string) {
  return serializedPerFile(source, async () => {
    const current = await readTextFile(source)
    if (current.kind !== 'ready') {
      // A lost reply may be retried after the move completed. Confirm the exact
      // destination contents before acknowledging that already-completed rename.
      const moved = current.kind === 'missing' ? await readTextFile(destination) : null
      if (moved?.kind === 'ready' && moved.revision === baseRevision) return { status: 'renamed', revision: moved.revision } as const
      return { status: 'rejected', message: 'This note is no longer available. Refresh the note list.' } as const
    }
    if (current.revision !== baseRevision) return { status: 'rejected', message: 'This note changed on disk. Read the latest version before renaming.' } as const
    if (source === destination) return { status: 'renamed', revision: current.revision } as const
    try {
      const original = await lstat(source)
      const existing = await lstat(destination).catch(() => null)
      // Case-only changes on a case-insensitive filesystem resolve to the same file.
      if (existing !== null && existing.ino === original.ino && existing.dev === original.dev && source.toLowerCase() === destination.toLowerCase()) {
        await rename(source, destination)
      } else {
        // link is exclusive, unlike rename, which silently replaces its destination.
        await link(source, destination)
        try {
          const beforeRemove = await lstat(source)
          if (beforeRemove.ino !== original.ino || beforeRemove.dev !== original.dev) throw new Error('Source changed during rename')
          await unlink(source)
        } catch (error) {
          const target = await lstat(destination).catch(() => null)
          if (target?.ino === original.ino && target.dev === original.dev) await unlink(destination).catch(() => undefined)
          throw error
        }
      }
      return { status: 'renamed', revision: current.revision } as const
    } catch (error) {
      return { status: 'rejected', message: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'A note with that name already exists.' : 'This note could not be renamed.' } as const
    }
  })
}
