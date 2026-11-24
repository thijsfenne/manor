import { realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CONTEXT_FILE_NAMES, type ContextFile, type ContextFileName, type ContextFiles } from '@manor/contracts'
import { readTextFile, replaceTextFile } from './fileIo.js'

/**
 * Settings' editor for the standing context files in the memory folder. `root` is
 * that folder, null where there is none. Only files that already exist are listed
 * or written: which ones exist is the folder's call.
 */

export type ContextFileSave =
  | { ok: true; file: ContextFile }
  | { ok: false; reason: 'unavailable' | 'missing' }
  | { ok: false; reason: 'stale'; current: ContextFile }

/** Through a symlink, so a save replaces the file it points at and the link stays. */
const resolveFile = (root: string, name: ContextFileName): Promise<string | undefined> =>
  realpath(path.join(root, name)).catch(() => undefined)

const modifiedAt = async (target: string): Promise<string> => (await stat(target)).mtime.toISOString()

async function readContextFile(root: string, name: ContextFileName): Promise<ContextFile | undefined> {
  const target = await resolveFile(root, name)
  if (target === undefined) return undefined
  const read = await readTextFile(target)
  if (read.kind !== 'ready') return undefined
  const updatedAt = await modifiedAt(target).catch(() => undefined)
  return updatedAt === undefined ? undefined : { name, content: read.content, hash: read.revision, updatedAt }
}

export async function readContextFiles(root: string | null): Promise<ContextFiles> {
  if (root === null) return { root: null, files: [] }
  const files = await Promise.all(CONTEXT_FILE_NAMES.map((name) => readContextFile(root, name)))
  return { root, files: files.filter((file) => file !== undefined) }
}

/**
 * Replaces one file only while it still hashes to `baseHash`, so an edit made outside
 * Manor since the editor opened comes back `stale` instead of being overwritten.
 */
export async function saveContextFile(
  root: string | null,
  name: ContextFileName,
  content: string,
  baseHash: string,
): Promise<ContextFileSave> {
  if (root === null) return { ok: false, reason: 'unavailable' }
  const target = await resolveFile(root, name)
  if (target === undefined) return { ok: false, reason: 'missing' }
  const saved = await replaceTextFile(target, Buffer.from(content, 'utf8'), baseHash)
  switch (saved.kind) {
    case 'saved':
      return { ok: true, file: { name, content, hash: saved.revision, updatedAt: await modifiedAt(target) } }
    case 'stale':
      return {
        ok: false,
        reason: 'stale',
        current: { name, content: saved.content, hash: saved.revision, updatedAt: await modifiedAt(target) },
      }
    case 'missing':
      return { ok: false, reason: 'missing' }
    case 'unreadable':
      throw new Error(`${name} is not a text file Manor can edit.`)
    case 'failed':
      throw new Error(`${name} could not be written.`)
  }
}

export type ContextFileCreate =
  | { ok: true; file: ContextFile }
  | { ok: false; reason: 'unavailable' | 'unknown' | 'exists' }

/**
 * Writes an empty file of one of the fixed names into the memory folder. Only the name
 * from `CONTEXT_FILE_NAMES` is joined to the folder, and `wx` keeps anything already
 * there (a file, or a link even when its target is gone) untouched.
 */
export async function createContextFile(root: string | null, name: string): Promise<ContextFileCreate> {
  if (root === null || !(await stat(root).then((info) => info.isDirectory(), () => false))) {
    return { ok: false, reason: 'unavailable' }
  }
  const known = CONTEXT_FILE_NAMES.find((candidate) => candidate === name)
  if (known === undefined) return { ok: false, reason: 'unknown' }
  const target = path.join(root, known)
  try {
    await writeFile(target, '', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'exists' }
    throw error
  }
  const file = await readContextFile(root, known)
  if (file === undefined) throw new Error(`${known} could not be read after it was created.`)
  return { ok: true, file }
}
