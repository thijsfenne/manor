import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { constants as zlibConstants, inflateSync } from 'node:zlib'
import { open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Project, ProjectRepoIcon, ServerMessage } from '@manor/contracts'

export const REPO_ICON_PREFIX = '/media/project-icon/'
/** Far above any favicon or 1024px app icon; a bigger file is not an icon. */
export const MAX_REPO_ICON_BYTES = 2 * 1024 * 1024

/**
 * The folders inside a linked folder where projects keep their icon, relative to its
 * root. A fixed list rather than a walk, so `node_modules`, build output and dot-folders
 * are never read, and the serving route accepts nothing outside it.
 */
const ICON_DIRS = ['', 'public', 'public/favicons', 'public/icons', 'static', 'assets', 'app', 'src/app']
const ICON_NAME = /^(?:favicon(?:-[\w.-]+)?\.(?:svg|png|ico)|apple-touch-icon[\w.-]*\.png|icon\.(?:svg|png))$/i

type IconKind = 'svg' | 'png' | 'ico'
const MIME: Record<IconKind, string> = { svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' }

/** Whether `relative` names an icon file in one of the known places, the only paths ever read. */
export function isRepoIconPath(relative: string): boolean {
  const cut = relative.lastIndexOf('/')
  return cut !== 0 && ICON_DIRS.includes(cut < 0 ? '' : relative.slice(0, cut)) && ICON_NAME.test(relative.slice(cut + 1))
}

interface RepoIconFile {
  kind: IconKind
  bytes: Buffer
  /** Pixels for a PNG, used to prefer the largest one; 0 for the other kinds. */
  area: number
  /** Whether the picture fills its square; SVG and ICO favicons are taken as having no background. */
  opaque: boolean
  etag: string
}

const extensionKind = (relative: string): IconKind => relative.slice(relative.lastIndexOf('.') + 1).toLowerCase() as IconKind

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Whether a PNG's top-left pixel is solid, which says whether the picture has a background.
 * The first pixel of the first row is stored as it is under every row filter and every
 * interlace pass, so the first inflated bytes answer it without decoding the image, and a
 * crafted stream that inflates to gigabytes costs no more than any other.
 */
function pngOpaque(bytes: Buffer): boolean {
  const depth = bytes[24] ?? 8
  const colour = bytes[25]
  let transparency: Buffer | undefined
  const data: Buffer[] = []
  let size = 0
  for (let at = 8; at + 8 <= bytes.length && size < 1024;) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    if (type === 'IEND') break
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'tRNS') transparency = body
    if (type === 'IDAT') {
      // Only the start of the stream: 1 KiB inflates to 1 MiB at most, and the pixel is in it.
      data.push(body.subarray(0, 1024 - size))
      size += Math.min(body.length, 1024 - size)
    }
    at += 12 + length
  }
  let row: Buffer
  try {
    row = inflateSync(Buffer.concat(data), { finishFlush: zlibConstants.Z_SYNC_FLUSH })
  } catch {
    return true
  }
  // row[0] is the row's filter type; the pixel follows, alpha last (its high byte at 16 bits).
  const sample = depth === 16 ? 2 : 1
  const alpha = colour === 6 ? row[1 + 3 * sample]
    : colour === 4 ? row[1 + sample]
    : colour === 3 && transparency !== undefined && row.length > 1 ? transparency[row[1]! >> (8 - depth)]
    : undefined
  return alpha === undefined || alpha >= 128
}

/** What the bytes say, which must match the extension: a text file called `icon.png` is no icon. */
function sniff(kind: IconKind, bytes: Buffer): { area: number; opaque: boolean } | undefined {
  if (kind === 'png') {
    const png = bytes.length >= 29 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    return png ? { area: bytes.readUInt32BE(16) * bytes.readUInt32BE(20), opaque: pngOpaque(bytes) } : undefined
  }
  if (kind === 'ico') return bytes.length >= 6 && bytes.readUInt32BE(0) === 0x00000100 ? { area: 0, opaque: false } : undefined
  // An SVG is text whose first element is <svg>, after an optional declaration, comments or doctype.
  const head = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '')
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>]/i.test(head) ? { area: 0, opaque: false } : undefined
}

/**
 * Reads one icon file of a linked folder, or undefined when it is not one. The path must
 * be a known icon place, resolve inside the folder after links, be a regular file under
 * the size cap and carry the bytes its extension promises.
 */
export async function readRepoIcon(folder: string, relative: string): Promise<RepoIconFile | undefined> {
  if (!isRepoIconPath(relative)) return undefined
  const root = await realpath(folder).catch(() => undefined)
  const real = root === undefined ? undefined : await realpath(path.join(root, relative)).catch(() => undefined)
  if (root === undefined || real === undefined || !real.startsWith(root + path.sep)) return undefined
  let handle
  try {
    // Already resolved, so a link swapped in after the check still fails to open; a pipe
    // swapped in opens without blocking and fails the file check below.
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return undefined
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size === 0 || info.size > MAX_REPO_ICON_BYTES) return undefined
    // Only the size checked above, so a file still growing cannot carry the read past the cap.
    const bytes = Buffer.alloc(info.size)
    let filled = 0
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const kind = extensionKind(relative)
    const body = bytes.subarray(0, filled)
    const sniffed = sniff(kind, body)
    if (sniffed === undefined) return undefined
    return { kind, bytes: body, area: sniffed.area, opaque: sniffed.opaque, etag: `"${Math.round(info.mtimeMs).toString(36)}-${filled.toString(36)}"` }
  } finally {
    await handle.close()
  }
}

const RANK: Record<IconKind, number> = { svg: 0, png: 1, ico: 2 }

/**
 * The icon a project's folders offer: the first folder holding one supplies it. Within
 * that folder an icon without a background beats one that fills its square, and then an
 * SVG beats the largest PNG, which beats an ICO.
 */
export async function findRepoIcon(folders: readonly string[]): Promise<ProjectRepoIcon | undefined> {
  for (const folder of folders) {
    const found: { path: string; kind: IconKind; area: number; opaque: boolean }[] = []
    for (const dir of ICON_DIRS) {
      const entries = await readdir(path.join(folder, dir), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !ICON_NAME.test(entry.name)) continue
        const relative = dir === '' ? entry.name : `${dir}/${entry.name}`
        const icon = await readRepoIcon(folder, relative)
        if (icon !== undefined) found.push({ path: relative, kind: icon.kind, area: icon.area, opaque: icon.opaque })
      }
    }
    // A stable sort, so equal icons keep the order of ICON_DIRS.
    const best = found.sort((one, other) => Number(one.opaque) - Number(other.opaque) || RANK[one.kind] - RANK[other.kind] || other.area - one.area)[0]
    if (best !== undefined) return { folder, path: best.path, ...(best.opaque ? { opaque: true as const } : {}) }
  }
  return undefined
}

/**
 * The stored repo icon still usable for these folders, or undefined. A folder unlinked
 * takes its icon with it, so the project wears its glyph again.
 */
export const keptRepoIcon = (icon: ProjectRepoIcon | undefined, repoPaths: readonly string[]): ProjectRepoIcon | undefined =>
  icon !== undefined && repoPaths.includes(icon.folder) && isRepoIconPath(icon.path) ? icon : undefined

export interface RepoIconMedia {
  /** The signed link of one icon in one project's folder. */
  src(projectId: string, icon: ProjectRepoIcon): string
  /** Adds `repoIconSrc` to every project in a directory whose repo icon's folder is linked. */
  forClient(message: ServerMessage): ServerMessage
  /** Serves a link from `src`; false when the request is not under the prefix. */
  handle(request: IncomingMessage, response: ServerResponse): boolean
}

/** Longest request path read, so a hostile URL costs nothing to refuse. */
const MAX_URL_CHARS = 4_096

/**
 * Serves repo icons as `/media/project-icon/<signature>/<project>/<folder>/<path>`. The
 * signature, keyed for one server process, covers all three, so only a link the server
 * handed out opens a file. Each request is checked again: the folder must still be linked
 * to that project and the path a known icon place inside it, so no link reads any other
 * file. An SVG goes out under a sandboxing policy and is drawn as an image, so it never
 * runs a script. `no-cache` with an ETag makes a client ask again, so a changed favicon shows.
 * An opaque icon's link ends in `?tile`, the clients' cue to round its corners; it is no
 * part of the signature and opens nothing.
 */
export function createRepoIconMedia(options: { getProject(projectId: string): Promise<Project | undefined>; key?: Buffer }): RepoIconMedia {
  const key = options.key ?? randomBytes(32)
  const sign = (projectId: string, folder: string, relative: string) =>
    createHmac('sha256', key).update(`${projectId}\n${folder}\n${relative}`).digest('base64url').slice(0, 32)
  const src = (projectId: string, icon: ProjectRepoIcon) =>
    `${REPO_ICON_PREFIX}${sign(projectId, icon.folder, icon.path)}/${[projectId, icon.folder, icon.path].map(encodeURIComponent).join('/')}${icon.opaque === true ? '?tile' : ''}`

  const withSrc = (project: Project): Project => {
    const { repoIconSrc: _stale, ...rest } = project
    const icon = keptRepoIcon(project.repoIcon, project.repoPaths)
    return icon === undefined ? rest : { ...rest, repoIconSrc: src(project.id, icon) }
  }

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const refuse = (status: number) => {
      response.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end()
    }
    const head = request.method === 'HEAD'
    if (request.method !== 'GET' && !head) return refuse(404)
    const raw = (request.url ?? '').slice(REPO_ICON_PREFIX.length).split(/[?#]/)[0] ?? ''
    if (raw.length > MAX_URL_CHARS) return refuse(404)
    const parts = raw.split('/')
    if (parts.length !== 4) return refuse(404)
    let projectId: string, folder: string, relative: string
    try {
      ;[projectId, folder, relative] = parts.slice(1).map(decodeURIComponent) as [string, string, string]
    } catch {
      return refuse(404)
    }
    const expected = Buffer.from(sign(projectId, folder, relative))
    const provided = Buffer.from(parts[0]!)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return refuse(404)

    const project = await options.getProject(projectId)
    if (project === undefined || !project.repoPaths.includes(folder)) return refuse(404)
    const icon = await readRepoIcon(folder, relative)
    if (icon === undefined) return refuse(404)

    const headers = {
      'content-type': MIME[icon.kind],
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-cache',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'referrer-policy': 'no-referrer',
      etag: icon.etag,
    }
    const sent = request.headers['if-none-match']
    if (typeof sent === 'string' && sent.split(',').some((candidate) => candidate.trim() === icon.etag)) {
      response.writeHead(304, headers)
      response.end()
      return
    }
    response.writeHead(200, { ...headers, 'content-length': String(icon.bytes.byteLength) })
    response.end(head ? undefined : icon.bytes)
  }

  return {
    src,
    forClient(message) {
      if (message.type !== 'directory' || !message.projects.some((project) => project.repoIcon !== undefined)) return message
      return { ...message, projects: message.projects.map(withSrc) }
    },
    handle(request, response) {
      if (request.url?.startsWith(REPO_ICON_PREFIX) !== true) return false
      void serve(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'cache-control': 'no-store' })
        response.end()
      })
      return true
    },
  }
}
