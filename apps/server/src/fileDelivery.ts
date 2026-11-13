import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DeliveredFileSchema, MAX_DELIVERED_FILE_BYTES, type DeliveredFile, type DeliveredViewport } from '@manor/contracts'
import { rasterMime, rasterSize } from './chatMedia.js'
import { isPreviewablePath } from './repoFiles.js'

/** A refusal whose message is written for the persona to pass on to the user as is. */
export class FileDeliveryError extends Error {}

/** Home folders that hold provider sign-ins or other credentials. Always refused. */
const CREDENTIAL_HOME_DIRS = ['.claude', '.codex', '.grok', '.cursor', '.config', 'Library/Keychains']
/**
 * Manor's own state, refused except for `~/.manor/scratch`, where most turns write
 * their output, and a goal Session's own worktree for its screenshots. The exception
 * lifts only those folders, never a credential one.
 */
const MANOR_DIR = '.manor'
const SCRATCH_DIR = '.manor/scratch'
const WORKTREES_DIR = 'worktrees'

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  key: 'application/vnd.apple.keynote',
  numbers: 'application/vnd.apple.numbers',
  pages: 'application/vnd.apple.pages',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  rtf: 'application/rtf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
}

export const deliveredMime = (name: string): string =>
  MIME_BY_EXTENSION[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'

const within = (target: string, root: string): boolean =>
  target === root || target.startsWith(`${root}${path.sep}`)

interface PrivateRoots {
  credentials: string[]
  manor: string[]
  /** Folders inside Manor's state that may still be shared: scratch and the asking Session's worktrees. */
  open: string[]
}

/** A folder both as written and as resolved, so one behind a symlink is still recognised. */
const bothForms = async (folder: string): Promise<string[]> =>
  [...new Set([folder, await realpath(folder).catch(() => folder)])]

async function privateRoots(home: string, worktrees: readonly string[]): Promise<PrivateRoots> {
  const homes = await bothForms(home)
  const under = async (dirs: string[]) =>
    (await Promise.all(homes.flatMap((root) => dirs.map((dir) => bothForms(path.join(root, dir)))))).flat()
  // Scratch and a worktree are exempt only where they really are: one symlinked to any
  // other folder, `~/.manor/codex-home` or another Session's worktree included, must
  // not promote that folder. So each resolves to the very place it is written under `.manor`.
  const scratch = path.join(home, SCRATCH_DIR)
  const realManor = await realpath(path.join(home, MANOR_DIR)).catch(() => undefined)
  const realScratch = await realpath(scratch).catch(() => undefined)
  const canonical = realManor !== undefined && realScratch === path.join(realManor, 'scratch')
  const sessions = realManor === undefined ? [] : (await Promise.all(worktrees.map(async (folder) => {
    const written = homes.map((root) => path.join(root, MANOR_DIR)).find((manor) => within(folder, manor))
    const expected = written === undefined ? undefined : path.join(realManor, path.relative(written, folder))
    const real = await realpath(folder).catch(() => undefined)
    const inWorktrees = expected !== undefined && expected !== path.join(realManor, WORKTREES_DIR) && within(expected, path.join(realManor, WORKTREES_DIR))
    return inWorktrees && real === expected ? [folder, real] : []
  }))).flat()
  return {
    credentials: await under(CREDENTIAL_HOME_DIRS),
    manor: await under([MANOR_DIR]),
    open: [...canonical ? await under([SCRATCH_DIR]) : [], ...sessions],
  }
}

/** Whether a path lies in a folder whose files must never enter a transcript. */
function isPrivatePath(target: string, roots: PrivateRoots): boolean {
  if (!isPreviewablePath(target.split(path.sep).join('/'))) return true
  const inAny = (list: string[]) => list.some((root) => within(target, root))
  if (inAny(roots.credentials)) return true
  return inAny(roots.manor) && !inAny(roots.open)
}

/**
 * A display name the user sees and saves under: a plain file name, no folders, and the
 * file's own extension when the requested name has none, so Save keeps the type.
 */
function displayName(requested: string | undefined, fallback: string): string {
  const cleaned = (requested ?? '').trim().replace(/[/\\:\u0000-\u001f]/g, '-')
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return fallback.slice(0, 160)
  const extension = path.extname(cleaned) === '' ? path.extname(fallback) : ''
  return `${cleaned.slice(0, 160 - extension.length)}${extension}`
}

const describe = (bytes: number): string =>
  bytes >= 1_024 * 1_024 ? `${(bytes / 1_024 / 1_024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_024))} KB`

/**
 * Checks and reads a file a persona asked to hand over. Every refusal names what is
 * wrong in one sentence, since the persona relays it and the user acts on it. A viewport
 * is kept only on HTML, the one type the chat draws: absent is a visual answer at the
 * column width, desktop or phone a mockup at that screen width. `worktrees` are the
 * asking Session's own checkouts under Manor's state.
 */
export async function readDeliverable(
  requestedPath: string,
  requestedName?: string,
  home = homedir(),
  viewport?: DeliveredViewport,
  worktrees: readonly string[] = [],
): Promise<{ file: DeliveredFile; bytes: Uint8Array }> {
  if (!path.isAbsolute(requestedPath)) {
    throw new FileDeliveryError(`"${requestedPath}" is not an absolute path. Pass the full path to the file.`)
  }
  let target: string
  try {
    target = await realpath(requestedPath)
  } catch {
    throw new FileDeliveryError(`${requestedPath} does not exist.`)
  }
  // The path as asked and as resolved, each against the private folders as written
  // and as resolved: a symlink on either side must not carry a secret past the check.
  const roots = await privateRoots(home, worktrees)
  if ([path.resolve(requestedPath), target].some((candidate) => isPrivatePath(candidate, roots))) {
    throw new FileDeliveryError(`${path.basename(target)} is in a private or credentials folder and cannot be shared in the chat.`)
  }
  // Typed before opening: opening a named pipe or device would block the turn.
  const notAFile = new FileDeliveryError(`${requestedPath} is not a file.`)
  if (!(await stat(target).catch(() => undefined))?.isFile()) throw notAFile
  let handle
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    throw new FileDeliveryError(`${requestedPath} could not be read. Check its permissions.`)
  }
  try {
    // Checked again on the open descriptor, in case the path was swapped in between.
    const info = await handle.stat()
    if (!info.isFile()) throw notAFile
    if (info.size === 0) throw new FileDeliveryError(`${path.basename(target)} is empty.`)
    if (info.size > MAX_DELIVERED_FILE_BYTES) {
      throw new FileDeliveryError(`${path.basename(target)} is ${describe(info.size)}; the limit is ${describe(MAX_DELIVERED_FILE_BYTES)}.`)
    }
    let bytes: Uint8Array
    try {
      bytes = await handle.readFile()
    } catch {
      throw new FileDeliveryError(`${requestedPath} could not be read.`)
    }
    // Read once and measured again: a file still being written may have grown past the cap.
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DELIVERED_FILE_BYTES) {
      throw new FileDeliveryError(`${path.basename(target)} changed while it was read. Deliver it once it is finished.`)
    }
    const name = displayName(requestedName, path.basename(target))
    const file = DeliveredFileSchema.parse({
      id: `file_${randomUUID()}`,
      name,
      mime: deliveredMime(name),
      size: bytes.byteLength,
      ...(viewport !== undefined && deliveredMime(name) === 'text/html' ? { viewport } : {}),
    })
    return { file, bytes }
  } finally {
    await handle.close()
  }
}

/** What a goal screenshot may weigh: a full-window PNG stays well under it. */
export const MAX_EVIDENCE_IMAGE_BYTES = 4 * 1_024 * 1_024

/**
 * Reads a screenshot a lead named on `goal_reached`, through the same private-folder
 * checks as a delivered file plus the Session's own worktrees, where verify-manor saves
 * its evidence. The bytes decide the type, by the check serving uses, so a card never
 * links a picture it cannot show; a file cut off before its header gives its pixel size
 * is refused too.
 */
export async function readEvidenceImage(
  requestedPath: string, worktrees: readonly string[] = [], home = homedir(),
): Promise<{ name: string; bytes: Uint8Array; width?: number; height?: number }> {
  const { file, bytes } = await readDeliverable(requestedPath, undefined, home, undefined, worktrees)
  const size = rasterSize(bytes)
  if (rasterMime(bytes) === undefined || size === undefined) throw new FileDeliveryError(`${file.name} is not a PNG, JPEG or WebP picture.`)
  if (bytes.byteLength > MAX_EVIDENCE_IMAGE_BYTES) {
    throw new FileDeliveryError(`${file.name} is ${describe(bytes.byteLength)}; a screenshot may be at most ${describe(MAX_EVIDENCE_IMAGE_BYTES)}.`)
  }
  return { name: file.name, bytes, ...size }
}
