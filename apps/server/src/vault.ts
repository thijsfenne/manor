import { constants } from 'node:fs'
import { cp, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { MAX_REPO_FILE_BYTES, MAX_VAULT_IMAGE_BYTES, attachmentFolderFor, isVaultImagePath, type FileWriteResult, type RepoFileResult } from '@manor/contracts'
import { hashBytes, moveTextFile, readTextFile, realMoveFs, renameTextFile, replaceTextFile, serializedPerFolder, type MoveFs } from './fileIo.js'

/**
 * How many notes the tree may hold. The user's vault is 370, so this never fires; it
 * exists so a `MANOR_VAULT_DIR` pointed at a home directory by mistake truncates
 * instead of putting a hundred thousand paths on the socket.
 */
export const MAX_VAULT_FILES = 5_000

/** The one configured vault, resolved once at boot so nothing re-stats it per request. */
export interface Vault {
  /** Absolute, symlinks already resolved. Every path guard compares against this. */
  root: string
  /** The folder's basename, which is what the tab is called. */
  name: string
}

export type OpenVaultResult = { ok: true; vault: Vault } | { ok: false; message: string }

/**
 * Turns a configured path into a usable vault, or says why it is not one. Called
 * once at boot: an unreachable vault costs the Knowledge tab, never the server, so
 * the caller logs this message and carries on without a vault.
 */
export async function openVault(dir: string): Promise<OpenVaultResult> {
  let root: string
  try {
    // Resolved here, once, because the vault lives under iCloud Drive and that path
    // is full of symlinks. Every later guard compares against the resolved root, so
    // a note reached through a link still lands inside it.
    root = await realpath(dir)
  } catch {
    return { ok: false, message: `The Knowledge folder ${dir} is not reachable from here.` }
  }
  const info = await stat(root).catch(() => null)
  if (info === null || !info.isDirectory()) {
    return { ok: false, message: `The Knowledge folder ${dir} is not a folder.` }
  }
  return { ok: true, vault: { root, name: path.basename(root) } }
}

export interface VaultListing {
  files: string[]
  folders: string[]
  /** Every picture, as a vault path, sorted. Not in the tree; embeds resolve against it. */
  images: string[]
  previews: Record<string, string>
  /** The cap cut the list. The tree says so rather than implying it saw everything. */
  truncated: boolean
}

/**
 * Every note in the vault, as `/`-separated paths relative to its root.
 *
 * Markdown only, and nothing under a dot-folder. That one rule covers `.obsidian`
 * (Obsidian's own config, not notes) and `.trash` (deleted notes Obsidian is still
 * holding) without a list of special cases to keep in sync with Obsidian's.
 */
export async function listVaultFiles(vault: Vault): Promise<VaultListing> {
  const files: string[] = []
  const folders: string[] = []
  const images: string[] = []
  const queue = ['']
  let truncated = false

  while (queue.length > 0 && !truncated) {
    const relative = queue.shift() as string
    let children
    try {
      children = await readdir(path.join(vault.root, relative), { withFileTypes: true })
    } catch {
      // One unreadable folder is skipped, never fatal: an iCloud folder that has not
      // materialised must not cost the whole tree.
      continue
    }
    for (const child of children) {
      // Checked per entry rather than per folder, so the cap is the number it says
      // it is instead of "the cap, plus whatever one more directory happened to hold".
      // Pictures have their own cap and never cut the walk short, so notes are not lost to them.
      if (files.length >= MAX_VAULT_FILES || folders.length >= MAX_VAULT_FILES) {
        truncated = true
        break
      }
      if (child.name.startsWith('.')) continue
      const childPath = relative === '' ? child.name : `${relative}/${child.name}`
      if (child.isDirectory()) { folders.push(childPath); queue.push(childPath) }
      else if (child.isFile() && isNote(child.name)) files.push(childPath)
      else if (child.isFile() && images.length < MAX_VAULT_FILES && isVaultImagePath(child.name)) images.push(childPath)
    }
  }

  files.sort((left, right) => left.localeCompare(right, 'en'))
  folders.sort((left, right) => left.localeCompare(right, 'en'))
  images.sort((left, right) => left.localeCompare(right, 'en'))
  const previews: Record<string, string> = {}
  let next = 0
  // Bound disk concurrency and bytes. Listing a vault must never read whole notes.
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next++]!
      let handle
      try {
        handle = await open(path.join(vault.root, file), constants.O_RDONLY | constants.O_NOFOLLOW)
        const buffer = Buffer.alloc(2048)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        previews[file] = notePreview(buffer.subarray(0, bytesRead).toString('utf8'))
      } catch { /* A temporarily unavailable note still belongs in the tree. */ }
      finally { await handle?.close() }
    }
  }))
  return { files, folders, images, previews, truncated }
}

/**
 * One note, with the content hash a later write sends back as its precondition.
 * Same four outcomes as a repo preview, because they are the same four honest
 * answers; `revision` is the one thing a vault read adds.
 */
export async function readVaultFile(vault: Vault, requestedPath: string): Promise<RepoFileResult> {
  const target = await resolveInVault(vault, requestedPath)
  if (target === null) return unavailable()

  const read = await readTextFile(target)
  if (read.kind === 'missing') return unavailable()
  if (read.kind === 'too_large') return { status: 'too_large', size: read.size, maxSize: MAX_REPO_FILE_BYTES }
  if (read.kind === 'binary') return { status: 'binary', size: read.size }
  return { status: 'ready', content: read.content, revision: read.revision }
}

/**
 * Saves one note, refusing when the file on disk is not the one the editor read.
 *
 * That check is the whole point of this function. Obsidian sits on the same machine,
 * personas have write access to the same folders, and iCloud syncs underneath all of
 * it; a plain write would silently take the last writer's word for it. `stale` hands
 * back what is there now, so the client can offer to keep either side.
 *
 * `baseRevision: null` means create. It uses an exclusive open rather than a
 * stat-then-write, so two creates of one path cannot both believe they were first.
 */
export async function writeVaultFile(
  vault: Vault,
  requestedPath: string,
  content: string,
  baseRevision: string | null,
): Promise<FileWriteResult> {
  const target = await resolveInVault(vault, requestedPath, baseRevision === null)
  if (target === null) {
    return { status: 'rejected', message: 'That is not a path inside the vault, or not a markdown note.' }
  }

  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength > MAX_REPO_FILE_BYTES) {
    return {
      status: 'rejected',
      message: `A note is capped at ${MAX_REPO_FILE_BYTES} bytes and this one is ${bytes.byteLength}.`,
    }
  }

  if (baseRevision === null) {
    let handle
    try {
      // Owner-only, explicitly: a note is personal and should not inherit the umask.
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      return { status: 'saved', revision: hashBytes(bytes) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { status: 'rejected', message: 'That note could not be created.' }
      }
      // Somebody got there first. Same answer as any other stale write, so the client
      // has one conflict flow instead of two.
      const existing = await readTextFile(target)
      return existing.kind === 'ready'
        ? { status: 'stale', revision: existing.revision, content: existing.content }
        : { status: 'rejected', message: 'There is already a file at that path.' }
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  const result = await replaceTextFile(target, bytes, baseRevision)
  switch (result.kind) {
    case 'saved':
      return { status: 'saved', revision: result.revision }
    case 'stale':
      return { status: 'stale', revision: result.revision, content: result.content }
    case 'missing':
      // Deliberately not a silent re-create: the note the editor was working on is
      // gone, and quietly resurrecting it hides that somebody deleted it.
      return { status: 'rejected', message: 'This note no longer exists on disk. Your text is still here.' }
    case 'unreadable':
      return { status: 'rejected', message: 'This note can no longer be read, so it will not be overwritten.' }
    case 'failed':
      return { status: 'rejected', message: 'That note could not be saved.' }
  }
}

/**
 * The absolute path for a client-supplied vault path, or null when it is not one.
 *
 * Deliberately not the repoFiles approach of listing everything and checking
 * membership: that costs a full walk per request and would refuse a note being
 * created, which has to pass this guard before it exists. Instead the rules are
 * explicit, and the containment check runs against the resolved parent folder, so an
 * intermediate symlink cannot walk out of the vault either.
 */
async function resolveInVault(vault: Vault, requestedPath: string, createInbox = false): Promise<string | null> {
  if (requestedPath.length === 0 || requestedPath.includes('\0')) return null
  if (path.isAbsolute(requestedPath)) return null

  const segments = requestedPath.split('/')
  const name = segments.at(-1) ?? ''
  // No empty, relative or hidden segment. `..` is the traversal, `.`-prefixed is
  // `.obsidian` and `.trash`, and both are refused here as well as in the listing so
  // a hand-crafted path cannot reach what the tree never offered.
  if (segments.some((segment) => segment === '' || segment === '.' || segment.startsWith('.'))) return null
  if (!isNote(name)) return null

  const target = path.join(vault.root, ...segments)
  const parent = path.dirname(target)
  let resolvedParent: string
  try {
    resolvedParent = await realpath(parent)
  } catch {
    // New-note always targets inbox, including a vault that has never had one.
    // Other missing folders still indicate a path the note browser cannot create.
    if (!createInbox || segments.length !== 2 || segments[0] !== 'inbox') return null
    try {
      await mkdir(parent).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      resolvedParent = await realpath(parent)
    } catch {
      return null
    }
  }
  if (resolvedParent !== vault.root && !resolvedParent.startsWith(vault.root + path.sep)) return null

  return path.join(resolvedParent, name)
}

/** The most `.obsidian/app.json` is read for; a real one is a few hundred bytes. */
const MAX_APP_SETTINGS_BYTES = 256 * 1024

/**
 * Obsidian's `attachmentFolderPath` from `.obsidian/app.json`, as written, or undefined
 * when the file, the key or a string value is missing. Never throws: a vault without
 * Obsidian settings simply keeps pictures at its root.
 */
export async function readAttachmentSetting(vault: Vault): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path.join(vault.root, '.obsidian', 'app.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_APP_SETTINGS_BYTES) return undefined
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value = (parsed as { attachmentFolderPath?: unknown }).attachmentFolderPath
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export interface SniffedImage {
  mime: string
  /** The extension a saved file carries: png, jpg, gif, webp or avif. */
  extension: string
}

/**
 * What a picture's own bytes say it is: PNG, JPEG, GIF, WebP or AVIF, else undefined. The
 * file name is never trusted, so a text file called `a.png` is not served or saved.
 */
export function sniffVaultImage(bytes: Uint8Array): SniffedImage | undefined {
  const at = (offset: number, ...expected: number[]) => expected.every((value, index) => bytes[offset + index] === value)
  const ascii = (offset: number, text: string) => at(offset, ...Array.from(text, (char) => char.charCodeAt(0)))
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: 'image/png', extension: 'png' }
  if (at(0, 0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', extension: 'jpg' }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { mime: 'image/gif', extension: 'gif' }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { mime: 'image/webp', extension: 'webp' }
  if (ascii(4, 'ftypavif') || ascii(4, 'ftypavis')) return { mime: 'image/avif', extension: 'avif' }
  return undefined
}

export type VaultImageSaveResult =
  | { status: 'saved'; path: string; name: string }
  | { status: 'rejected'; message: string }

const rejectedImage = (message: string) => ({ status: 'rejected', message }) as const

const isInside = (root: string, target: string) => target === root || target.startsWith(root + path.sep)

/** Obsidian's own name for a pasted picture: `Pasted image 20260101123045`, local time. */
function pastedImageStem(now: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `Pasted image ${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
}

/** The file name without its folder, extension or the characters an Obsidian link cannot carry. */
function cleanImageStem(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? ''
  const stem = base.replace(/\.(?:png|jpe?g|gif|webp|avif)$/i, '')
  return stem.replace(/[[\]#^|\\/:\u0000-\u001f\u007f]/g, '').trim().replace(/^\.+/, '').trim().slice(0, 120).trim()
}

/**
 * Saves a pasted or dropped picture next to the note it belongs in, the way Obsidian
 * does. The folder comes from the vault's attachment setting; the name is cleaned, given
 * the extension the bytes call for and made unique across every vault picture, because
 * `![[name.png]]` resolves by name alone. The file is created exclusively, so two saves
 * of one name cannot both win.
 */
export async function saveVaultImage(
  vault: Vault,
  input: { notePath: string; name: string; bytes: Uint8Array; existingImages: readonly string[]; now?: Date },
): Promise<VaultImageSaveResult> {
  const note = await resolveInVault(vault, input.notePath)
  if (note === null || !(await lstat(note).then((info) => info.isFile(), () => false))) {
    return rejectedImage('That note is not available, so the picture was not saved.')
  }
  const sniffed = sniffVaultImage(input.bytes)
  if (sniffed === undefined) return rejectedImage('That is not a picture Manor can keep (PNG, JPEG, GIF, WebP or AVIF).')
  if (input.bytes.byteLength > MAX_VAULT_IMAGE_BYTES) {
    return rejectedImage(`A picture is capped at ${Math.round(MAX_VAULT_IMAGE_BYTES / (1024 * 1024))} MB.`)
  }

  const folder = attachmentFolderFor(await readAttachmentSetting(vault), input.notePath)
  const segments = folder === '' ? [] : folder.split('/')
  if (folder.includes('\0') || segments.some((segment) => segment === '' || segment.startsWith('.'))) {
    return rejectedImage('The vault\'s attachment folder is not a folder Manor may write to.')
  }
  const target = await ensureFolderInVault(vault, segments)
  if (target === null) return rejectedImage('The vault\'s attachment folder is not inside the vault.')

  const stem = cleanImageStem(input.name) || pastedImageStem(input.now ?? new Date())
  const taken = new Set(input.existingImages.map((image) => image.slice(image.lastIndexOf('/') + 1).toLowerCase()))
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const name = `${attempt === 0 ? stem : `${stem} ${attempt}`}.${sniffed.extension}`
    if (taken.has(name.toLowerCase())) continue
    const file = path.join(target, name)
    let handle
    try {
      handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await handle.writeFile(input.bytes)
      await handle.sync()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      // The file was created by this save, so a half-written one goes again.
      if (handle !== undefined) {
        await handle.close().catch(() => undefined)
        handle = undefined
        await unlink(file).catch(() => undefined)
      }
      return rejectedImage('That picture could not be saved.')
    } finally {
      await handle?.close().catch(() => undefined)
    }
    return { status: 'saved', path: folder === '' ? name : `${folder}/${name}`, name }
  }
  return rejectedImage('That picture could not be given a free name.')
}

/**
 * The absolute folder for vault `segments`, created when missing. The deepest folder that
 * already exists must resolve inside the vault before anything is made, and the created
 * folder is resolved again after, so a symlinked ancestor cannot carry the write out.
 */
async function ensureFolderInVault(vault: Vault, segments: readonly string[]): Promise<string | null> {
  const wanted = path.join(vault.root, ...segments)
  let ancestor = wanted
  let resolved: string | null = null
  while (resolved === null) {
    resolved = await realpath(ancestor).catch(() => null)
    if (resolved === null) {
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return null
      ancestor = parent
    }
  }
  if (!isInside(vault.root, resolved)) return null
  if (ancestor !== wanted) {
    try {
      await mkdir(wanted, { recursive: true, mode: 0o700 })
    } catch {
      return null
    }
  }
  const final = await realpath(wanted).catch(() => null)
  const info = final === null ? null : await stat(final).catch(() => null)
  return final !== null && info?.isDirectory() === true && isInside(vault.root, final) ? final : null
}

const isNote = (name: string) => name.length > 3 && name.toLowerCase().endsWith('.md')

const unavailable = (): RepoFileResult => ({
  status: 'unavailable',
  message: 'That note is not available.',
})

/** A short body excerpt, without frontmatter, headings or Markdown punctuation. */
export function notePreview(content: string): string {
  const body = content.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
  // Headings, fences, dividers, table rows and lone pictures are structure, not a sentence to preview.
  const line = body.split(/\r?\n/).find((line) => line.trim() !== '' && !/^\s*(?:#{1,6}(?:\s|$)|```|~~~|(?:[-*_]\s*){3,}$|\||!\[\[[^\]]*\]\]\s*$|!\[[^\]]*\]\([^)]*\)\s*$)/.test(line)) ?? ''
  return line
    // Block marks first: quote bars, then a list marker, then a task box or callout token.
    .replace(/^\s*(?:>\s?)+/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '').replace(/^\[![A-Za-z]+\][-+]?\s*/, '')
    .replace(/!\[\[[^\]]*\]\]/g, '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/~~|==|[*_`]/g, '').trim().slice(0, 180)
}

export async function createVaultFolder(vault: Vault, requestedPath: string) {
  const segments = requestedPath.split('/')
  if (path.isAbsolute(requestedPath) || requestedPath.includes('\0') || segments.some((part) => !part || part.startsWith('.'))) {
    return { status: 'rejected', message: 'Choose a folder name inside the vault.' } as const
  }
  const parent = await realpath(path.join(vault.root, ...segments.slice(0, -1))).catch(() => null)
  if (parent === null || (parent !== vault.root && !parent.startsWith(vault.root + path.sep))) {
    return { status: 'rejected', message: 'The parent folder is not available inside the vault.' } as const
  }
  try {
    await mkdir(path.join(parent, segments.at(-1)!), { mode: 0o700 })
    return { status: 'created' } as const
  } catch (error) {
    return { status: 'rejected', message: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'A file or folder with that name already exists.' : 'That folder could not be created.' } as const
  }
}

export async function renameVaultFile(vault: Vault, requestedPath: string, newPath: string, baseRevision: string) {
  const source = await resolveInVault(vault, requestedPath)
  const destination = await resolveInVault(vault, newPath)
  if (source === null || destination === null || path.dirname(source) !== path.dirname(destination) || Buffer.byteLength(path.basename(destination)) > 255) {
    return { status: 'rejected', message: 'Choose a Markdown filename in the same folder.' } as const
  }
  return renameTextFile(source, destination, baseRevision)
}

export type VaultMoveResult =
  /** `newPath` equal to the requested path means the entry already sat in that folder. */
  | { status: 'moved'; kind: 'note' | 'folder'; newPath: string }
  | { status: 'rejected'; message: string }

/**
 * Moves one note or folder into another folder of the vault, keeping its name. `folder`
 * is the destination relative to the root, `''` for the top level.
 *
 * The same path rules as every other vault write: relative, no traversal, nothing hidden,
 * parents resolved so a symlinked folder cannot walk out, and the entry itself lstat'd so
 * a symlink is refused. The destination folder must already exist. A name already taken
 * there is refused, never overwritten and never renamed around. A folder cannot move
 * into itself or into a folder inside it.
 */
export async function moveVaultEntry(
  vault: Vault,
  requestedPath: string,
  folder: string,
  { fs = realMoveFs }: { fs?: MoveFs } = {},
): Promise<VaultMoveResult> {
  const refused = (message: string) => ({ status: 'rejected', message }) as const
  const plain = (segments: string[]) => segments.every((part) => part !== '' && !part.startsWith('.'))
  const segments = requestedPath.split('/')
  if (requestedPath === '' || path.isAbsolute(requestedPath) || requestedPath.includes('\0') || !plain(segments)) {
    return refused('That is not a note or folder in the Knowledge tree.')
  }
  const folderSegments = folder === '' ? [] : folder.split('/')
  if (path.isAbsolute(folder) || folder.includes('\0') || !plain(folderSegments)) {
    return refused('Choose a folder inside the Knowledge tree.')
  }

  const inside = (resolved: string | null): resolved is string =>
    resolved !== null && (resolved === vault.root || resolved.startsWith(vault.root + path.sep))
  const parent = await realpath(path.join(vault.root, ...segments.slice(0, -1))).catch(() => null)
  if (!inside(parent)) return refused('That is not a note or folder in the Knowledge tree.')
  const name = segments.at(-1)!
  const source = path.join(parent, name)
  const info = await lstat(source).catch(() => null)
  if (info === null) return refused('That note or folder is no longer there. Refresh the tree.')
  const kind = info.isDirectory() ? 'folder' : info.isFile() && isNote(name) ? 'note' : null
  if (kind === null) return refused('That is not a note or folder in the Knowledge tree.')

  const target = await realpath(path.join(vault.root, ...folderSegments)).catch(() => null)
  const targetInfo = target === null ? null : await stat(target).catch(() => null)
  if (!inside(target) || targetInfo === null || !targetInfo.isDirectory()) {
    return refused('That folder is not in the Knowledge tree any more. Refresh the tree.')
  }
  if (target === parent) return { status: 'moved', kind, newPath: requestedPath }
  if (kind === 'folder' && (target === source || target.startsWith(source + path.sep))) {
    return refused('A folder cannot move into itself or into one of its own folders.')
  }

  const newPath = [...folderSegments, name].join('/')
  const destination = path.join(target, name)
  const clash = `${folder === '' ? 'The top level' : `“${folderSegments.at(-1)}”`} already has a note or folder named “${name}”. Rename one of them first.`
  if (kind === 'note') {
    const moved = await moveTextFile(source, destination, fs)
    if (moved === 'moved') return { status: 'moved', kind, newPath }
    if (moved === 'exists') return refused(clash)
    if (moved === 'missing') return refused('That note is no longer there. Refresh the tree.')
    return refused('That note could not be moved. Nothing changed.')
  }

  // A folder cannot be hard-linked, and rename replaces an empty folder in its way. So the
  // name is claimed first with an exclusive mkdir, and the rename replaces only that claim.
  // No save, rename or move of a note inside the folder may interleave with it.
  return serializedPerFolder(source, async () => {
    try {
      await mkdir(destination, { mode: 0o700 })
    } catch (error) {
      return refused((error as NodeJS.ErrnoException).code === 'EEXIST' ? clash : 'That folder could not be moved. Nothing changed.')
    }
    try {
      await fs.rename(source, destination)
      return { status: 'moved', kind, newPath } as const
    } catch {
      await rmdir(destination).catch(() => undefined)
      return refused('That folder could not be moved. Nothing changed.')
    }
  })
}

export type VaultDeleteResult =
  | { status: 'deleted'; kind: 'note' | 'folder'; trashPath: string }
  /** `listingChanged` means part of the entry may be gone, so the caller re-announces the tree. */
  | { status: 'rejected'; message: string; listingChanged?: true }

/**
 * Moves one note or folder out of the vault into `trashRoot/<UTC stamp>/<path>`, so the
 * tree shape survives and the user can move it back by hand. Never a hard delete.
 *
 * The same rules as every other vault path: relative, no traversal, nothing hidden, and
 * the parent resolved so a symlinked folder cannot walk out. The entry itself is lstat'd
 * and a symlink is refused, because the tree never lists one. The root is refused.
 */
export async function deleteVaultEntry(
  vault: Vault,
  requestedPath: string,
  trashRoot: string,
  { now = new Date(), move = moveEntry }: { now?: Date; move?: typeof moveEntry } = {},
): Promise<VaultDeleteResult> {
  const refused = (message: string) => ({ status: 'rejected', message }) as const
  const segments = requestedPath.split('/')
  if (requestedPath.trim() === '' || requestedPath === '.') return refused('The Knowledge folder itself cannot be deleted.')
  if (path.isAbsolute(requestedPath) || requestedPath.includes('\0') || segments.some((part) => part === '' || part.startsWith('.'))) {
    return refused('That is not a note or folder in the Knowledge tree.')
  }
  const parent = await realpath(path.join(vault.root, ...segments.slice(0, -1))).catch(() => null)
  if (parent === null || (parent !== vault.root && !parent.startsWith(vault.root + path.sep))) {
    return refused('That is not a note or folder in the Knowledge tree.')
  }
  const source = path.join(parent, segments.at(-1)!)
  const info = await lstat(source).catch(() => null)
  if (info === null) return refused('That note or folder is already gone.')
  const kind = info.isDirectory() ? 'folder' : info.isFile() && isNote(source) ? 'note' : null
  if (kind === null) return refused('That is not a note or folder in the Knowledge tree.')

  const trash = path.resolve(trashRoot)
  // A vault pointed at Manor's own data folder would otherwise move the trash into itself.
  if (kind === 'folder' && (trash === source || trash.startsWith(source + path.sep))) {
    return refused('That folder holds Manor\'s trash, so it cannot be moved there.')
  }

  // An iCloud note that is not downloaded is only a `.name.icloud` stub on disk. Moving
  // the stub out of iCloud Drive trashes the stub while iCloud deletes the real note.
  if (await holdsCloudPlaceholder(source)) {
    return refused('Some notes in this folder are only in iCloud and not on this Mac. Download them first (open the folder in Finder and choose Download Now), then delete.')
  }

  let destination: string
  try {
    await mkdir(trash, { recursive: true, mode: 0o700 })
    const bucket = await claimBucket(trash, now)
    destination = path.join(bucket, ...segments)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  } catch {
    return refused(`That ${kind} could not be moved to the trash. Nothing was removed.`)
  }
  try {
    await move(source, destination)
    return { status: 'deleted', kind, trashPath: destination }
  } catch (error) {
    if (error instanceof SourceChangedError) {
      return refused(`That ${kind} changed while it was being deleted, so nothing was removed. The copy in the trash at ${destination} can be discarded.`)
    }
    if (error instanceof SourceRemovalError) {
      return {
        status: 'rejected',
        message: `That ${kind} was copied to the trash at ${destination}, but removing the original failed partway. Part of it may still be in the Knowledge folder.`,
        listingChanged: true,
      }
    }
    return refused(`That ${kind} could not be moved to the trash. Nothing was removed.`)
  }
}

const isCloudPlaceholder = (name: string) => name.startsWith('.') && name.endsWith('.icloud')

async function holdsCloudPlaceholder(target: string): Promise<boolean> {
  if (isCloudPlaceholder(path.basename(target))) return true
  const info = await lstat(target)
  if (!info.isDirectory()) return false
  for (const child of await readdir(target, { withFileTypes: true })) {
    if (isCloudPlaceholder(child.name)) return true
    if (child.isDirectory() && (await holdsCloudPlaceholder(path.join(target, child.name)))) return true
  }
  return false
}

/**
 * One fresh folder per delete, named by its UTC time. Created exclusively, so a second
 * delete of the same name in the same millisecond gets `-2` and never overwrites the first.
 */
async function claimBucket(trash: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/:/g, '-')
  for (let attempt = 1; attempt < 1_000; attempt += 1) {
    const bucket = path.join(trash, attempt === 1 ? stamp : `${stamp}-${attempt}`)
    try {
      await mkdir(bucket, { mode: 0o700 })
      return bucket
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('no free trash folder')
}

/** The source changed between the copy and its removal, so the original was left alone. */
export class SourceChangedError extends Error {}
/** The verified copy is in the trash, but removing the original failed, possibly partway. */
export class SourceRemovalError extends Error {}

/**
 * A rename, or across volumes a copy that is checked by entry count and byte total before
 * the original is removed. A copy that does not match is removed and the original stays.
 * The source is counted again right before its removal, so a file written into it during
 * the copy stays in the vault instead of being removed without reaching the trash.
 * `fs` is a seam for tests.
 */
export async function moveEntry(
  source: string,
  destination: string,
  fs: { rename?: typeof rename; cp?: typeof cp; rm?: typeof rm } = {},
): Promise<void> {
  const { rename: renameEntry = rename, cp: copy = cp, rm: remove = rm } = fs
  try {
    await renameEntry(source, destination)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  const before = await tally(source)
  await copy(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
  const copied = await tally(destination)
  if (copied.entries !== before.entries || copied.bytes !== before.bytes) {
    await remove(destination, { recursive: true, force: true })
    throw new Error('the copy in the trash does not match the original')
  }
  const again = await tally(source)
  if (again.entries !== before.entries || again.bytes !== before.bytes) throw new SourceChangedError('the original changed during the copy')
  try {
    await remove(source, { recursive: true })
  } catch (error) {
    throw new SourceRemovalError('the original could not be removed', { cause: error })
  }
}

async function tally(target: string): Promise<{ entries: number; bytes: number }> {
  const info = await lstat(target)
  if (!info.isDirectory()) return { entries: 1, bytes: info.size }
  let entries = 1
  let bytes = 0
  for (const child of await readdir(target)) {
    const sub = await tally(path.join(target, child))
    entries += sub.entries
    bytes += sub.bytes
  }
  return { entries, bytes }
}
