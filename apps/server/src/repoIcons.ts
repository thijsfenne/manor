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
 * are never read, and the serving route accepts nothing outside it. A monorepo keeps its
 * icons in its packages, so the same folders count inside each `apps/<name>` and
 * `packages/<name>` too, after the root's.
 */
const ICON_DIRS = ['', 'public', 'public/favicons', 'public/icons', 'static', 'assets', 'assets/images', 'app', 'src/app']
const WORKSPACE_DIRS = ['apps', 'packages']
/** A package folder's name: one path segment, no dot-folder or `..`, never `node_modules` in any case. */
const PACKAGE_NAME = /^(?!node_modules$)[^./\\\0][^/\\\0]*$/i
/** The wire contract's longest icon path. */
const MAX_PATH_CHARS = 512
const ICON_NAME = /^(?:favicon(?:-[\w.-]+)?\.(?:svg|png|ico)|apple-touch-icon[\w.-]*\.png|icon\.(?:svg|png))$/i

/** `dir` with a leading `apps/<name>` or `packages/<name>` taken off; undefined when that name is not a package's. */
function iconDirOf(dir: string): string | undefined {
  const [workspace, name, ...rest] = dir.split('/')
  if (workspace === undefined || name === undefined || !WORKSPACE_DIRS.includes(workspace)) return dir
  return PACKAGE_NAME.test(name) ? rest.join('/') : undefined
}

type IconKind = 'svg' | 'png' | 'ico'
const MIME: Record<IconKind, string> = { svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' }

/** Whether `relative` names an icon file in one of the known places, the only paths ever read. */
export function isRepoIconPath(relative: string): boolean {
  const cut = relative.lastIndexOf('/')
  if (relative.length > MAX_PATH_CHARS || cut === 0 || !ICON_NAME.test(relative.slice(cut + 1))) return false
  const dir = iconDirOf(cut < 0 ? '' : relative.slice(0, cut))
  return dir !== undefined && ICON_DIRS.includes(dir)
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
  for (const { type, body } of pngChunks(bytes)) {
    if (size >= 1024) break
    if (type === 'tRNS') transparency = body
    if (type === 'IDAT') {
      // Only the start of the stream: 1 KiB inflates to 1 MiB at most, and the pixel is in it.
      data.push(body.subarray(0, 1024 - size))
      size += Math.min(body.length, 1024 - size)
    }
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

/** A PNG's chunks up to its end, each as its type and body. */
function* pngChunks(bytes: Buffer) {
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    if (type === 'IEND') return
    yield { type, body: bytes.subarray(at + 8, at + 8 + length) }
    at += 12 + length
  }
}

/** The biggest picture decoded to measure it: a 2048px RGBA icon, in bytes and in pixels. */
const MAX_DECODED_BYTES = 16 * 1024 * 1024
const MAX_DECODED_PIXELS = 2048 * 2048

interface DecodedPng {
  width: number
  height: number
  /** Whether the pixel is at least half opaque; undefined for a PNG without an alpha channel or palette transparency. */
  solid: ((x: number, y: number) => boolean) | undefined
  /** Whether a grey or RGB PNG names one colour as transparent, which `solid` does not read. */
  keyed: boolean
  /** The pixel's red, green and blue, 0 to 255. */
  colour(x: number, y: number): [number, number, number]
}

/**
 * Decodes a whole PNG to read its pixels, or undefined when it is interlaced, too big, cut
 * short, or stores pixels this does not read: palettes at any depth, everything else at 8
 * or 16 bits.
 */
function decodePng(bytes: Buffer): DecodedPng | undefined {
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const depth = bytes[24]
  const type = bytes[25]
  const channels = type === 6 ? 4 : type === 4 ? 2 : type === 2 ? 3 : type === 3 || type === 0 ? 1 : 0
  const depths = type === 3 ? [1, 2, 4, 8] : [8, 16]
  if (channels === 0 || depth === undefined || !depths.includes(depth) || bytes[28] !== 0) return undefined
  const sample = depth / 8
  // The filters step back a whole pixel, or one byte when pixels are packed smaller.
  const pixel = Math.max(1, channels * sample)
  // Each row is one filter byte and then its pixels.
  const row = Math.ceil((width * channels * depth) / 8) + 1
  const decoded = row * height
  if (width === 0 || height === 0 || decoded > MAX_DECODED_BYTES || width * height > MAX_DECODED_PIXELS) return undefined
  let palette: Buffer | undefined
  let transparency: Buffer | undefined
  const data: Buffer[] = []
  for (const chunk of pngChunks(bytes)) {
    if (chunk.type === 'PLTE') palette = chunk.body
    if (chunk.type === 'tRNS') transparency = chunk.body
    if (chunk.type === 'IDAT') data.push(chunk.body)
  }
  if (type === 3 && palette === undefined) return undefined
  let raw: Buffer
  try {
    // A stream that inflates past the picture's own size is refused, not decoded.
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: decoded })
  } catch {
    return undefined
  }
  if (raw.length !== decoded) return undefined
  // Undo each row's filter in place: its left, upper and upper-left neighbours are already undone.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * row]
    if (filter === undefined || filter > 4) return undefined
    for (let i = 1; i < row; i++) {
      const at = y * row + i
      const left = i > pixel ? raw[at - pixel]! : 0
      const up = y > 0 ? raw[at - row]! : 0
      let add = 0
      if (filter === 1) add = left
      else if (filter === 2) add = up
      else if (filter === 3) add = (left + up) >> 1
      else if (filter === 4) {
        const corner = i > pixel && y > 0 ? raw[at - row - pixel]! : 0
        const guess = left + up - corner
        const [toLeft, toUp, toCorner] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - corner)]
        add = toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner
      }
      raw[at] = (raw[at]! + add) & 0xff
    }
  }
  // A sample's high byte, which is all a 16-bit one needs here.
  const channel = (x: number, y: number, index: number) => raw[y * row + 1 + x * pixel + index * sample]!
  const paletteIndex = (x: number, y: number) => {
    const bit = x * depth
    return (raw[y * row + 1 + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
  }
  return {
    width,
    height,
    keyed: (type === 0 || type === 2) && transparency !== undefined,
    solid: type === 6 || type === 4 ? (x, y) => channel(x, y, channels - 1) >= 128
      : type === 3 && transparency !== undefined ? (x, y) => (transparency[paletteIndex(x, y)] ?? 255) >= 128
      : undefined,
    colour(x, y) {
      if (type === 3) {
        const at = paletteIndex(x, y) * 3
        return [palette![at] ?? 0, palette![at + 1] ?? 0, palette![at + 2] ?? 0]
      }
      return channels >= 3 ? [channel(x, y, 0), channel(x, y, 1), channel(x, y, 2)] : [channel(x, y, 0), channel(x, y, 0), channel(x, y, 0)]
    },
  }
}

/**
 * The share of each side a PNG without a background leaves empty around its picture, such
 * as the margin a macOS app icon keeps for its shadow: the narrowest gap between an edge and
 * the box around every pixel at least half opaque. Clients crop that much from every side,
 * so the picture fills its square like an icon without a margin and nothing of it is cut.
 * 0 under 2%, and when the PNG has no alpha or is not decoded.
 */
function pngInset(png: DecodedPng): number {
  const { width, height, solid } = png
  if (solid === undefined) return 0
  let [minX, minY, maxX, maxY] = [width, height, -1, -1]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!solid(x, y)) continue
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  if (maxX < 0) return 0
  const inset = Math.min(minX / width, (width - 1 - maxX) / width, minY / height, (height - 1 - maxY) / height)
  return inset < 0.02 ? 0 : Math.floor(Math.min(inset, 0.25) * 1000) / 1000
}

/** The corner radius, as a share of the side, every tile gets at least. */
const TILE_RADIUS = 0.22

/**
 * The corner radius, as a share of the side, of a square picture that draws its own rounded
 * plate on a plain square, such as an app icon: the circle that meets each corner's diagonal
 * where the plate starts, a hair rounder so the soft edge of the rounding falls on the plate,
 * and never under a tile's own. Clients draw it as a plain arc, since a squircle of the same
 * radius cuts far less deep at the diagonal. A plate with smoother corners than a circle
 * keeps a sliver of its square near the edges, about 1% of the side, under a pixel at icon
 * sizes. 0 when the four corners are not the same colour, when that colour also reaches the
 * middle of an edge (the square is the picture's background, not a canvas around a plate),
 * when the four corners disagree or are cut square, and when a colour is marked transparent.
 */
function pngCornerRadius(png: DecodedPng): number {
  const { width: side, height, keyed } = png
  if (side !== height || keyed) return 0
  const canvas = png.colour(0, 0)
  const near = ([r, g, b]: [number, number, number]) =>
    Math.max(Math.abs(r - canvas[0]), Math.abs(g - canvas[1]), Math.abs(b - canvas[2])) <= 6
  const middle = side >> 1
  if ([png.colour(middle, 0), png.colour(middle, side - 1), png.colour(0, middle), png.colour(side - 1, middle)].some(near)) return 0
  // How far each corner's canvas runs along its diagonal, and along its top or bottom edge.
  const runs = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([dx, dy]) => {
    const at = (x: number, y: number) => png.colour(dx === 1 ? x : side - 1 - x, dy === 1 ? y : side - 1 - y)
    let diagonal = 0
    while (diagonal < middle && near(at(diagonal, diagonal))) diagonal++
    let edge = 0
    while (edge < middle && near(at(edge, 0))) edge++
    return { diagonal, edge }
  })
  const diagonals = runs.map((run) => run.diagonal)
  const longest = Math.max(...diagonals)
  if (Math.min(...diagonals) === 0 || longest - Math.min(...diagonals) > side * 0.02) return 0
  // A rounded corner runs along its edge well past its diagonal (3.4 times for a circle, less
  // once a small icon rounds it to whole pixels); a square cut does not.
  if (runs.some((run) => run.edge < run.diagonal * 1.5)) return 0
  // A circle of radius r leaves r(1 - √½) of its corner's diagonal outside it.
  const share = Math.ceil(Math.min(longest / (1 - Math.SQRT1_2) / side + 0.01, 0.5) * 1000) / 1000
  return Math.max(share, TILE_RADIUS)
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
    // The root's own icon wins; only a folder without one looks into its packages.
    const best = await bestIcon(folder, ICON_DIRS) ?? await bestIcon(folder, await packageIconDirs(folder))
    if (best !== undefined) return iconRef(folder, best.path, best.icon)
  }
  return undefined
}

/**
 * The reference stored for one icon file, with what the server reads from its pixels:
 * whether it fills its square and how round its corner must be, or how much margin it leaves. Undefined when it is no icon.
 */
export async function repoIconRef(folder: string, relative: string): Promise<ProjectRepoIcon | undefined> {
  const icon = await readRepoIcon(folder, relative)
  return icon === undefined ? undefined : iconRef(folder, relative, icon)
}

function iconRef(folder: string, relative: string, icon: RepoIconFile): ProjectRepoIcon {
  const png = icon.kind === 'png' ? decodePng(icon.bytes) : undefined
  const inset = png !== undefined && !icon.opaque ? pngInset(png) : 0
  const radius = png !== undefined && icon.opaque ? pngCornerRadius(png) : 0
  return {
    folder,
    path: relative,
    ...(icon.opaque ? { opaque: true as const } : {}),
    ...(inset > 0 ? { inset } : {}),
    ...(radius > 0 ? { radius } : {}),
  }
}

/** The icon folders of every `apps/<name>` and `packages/<name>` in a linked folder, in name order. */
async function packageIconDirs(folder: string): Promise<string[]> {
  const dirs: string[] = []
  for (const workspace of WORKSPACE_DIRS) {
    const entries = await readdir(path.join(folder, workspace), { withFileTypes: true }).catch(() => [])
    const names = entries.filter((entry) => entry.isDirectory() && PACKAGE_NAME.test(entry.name)).map((entry) => entry.name).sort()
    for (const name of names) dirs.push(...ICON_DIRS.map((dir) => (dir === '' ? `${workspace}/${name}` : `${workspace}/${name}/${dir}`)))
  }
  return dirs
}

/** The icon to offer among `dirs`: one without a background first, then svg, png by size, ico. */
async function bestIcon(folder: string, dirs: readonly string[]) {
  const compare = (one: RepoIconFile, other: RepoIconFile) =>
    Number(one.opaque) - Number(other.opaque) || RANK[one.kind] - RANK[other.kind] || other.area - one.area
  let best: { path: string; icon: RepoIconFile } | undefined
  // Listed together, since most of these folders do not exist in a given repo.
  const listings = await Promise.all(dirs.map((dir) => readdir(path.join(folder, dir), { withFileTypes: true }).catch(() => [])))
  for (const [index, dir] of dirs.entries()) {
    for (const entry of listings[index] ?? []) {
      if (!entry.isFile() || !ICON_NAME.test(entry.name)) continue
      const relative = dir === '' ? entry.name : `${dir}/${entry.name}`
      const icon = await readRepoIcon(folder, relative)
      // Only a strictly better icon takes over, so equal ones keep the order of `dirs`.
      if (icon !== undefined && (best === undefined || compare(icon, best.icon) < 0)) best = { path: relative, icon }
    }
  }
  return best
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
 * An opaque icon's link ends in `?tile`, the clients' cue to round its corners (`?tile=<share>`
 * when its own plate needs a rounder corner), and one with a margin in `?inset=<share>`, their
 * cue to crop it; neither is part of the signature and neither opens anything.
 */
export function createRepoIconMedia(options: { getProject(projectId: string): Promise<Project | undefined>; key?: Buffer }): RepoIconMedia {
  const key = options.key ?? randomBytes(32)
  const sign = (projectId: string, folder: string, relative: string) =>
    createHmac('sha256', key).update(`${projectId}\n${folder}\n${relative}`).digest('base64url').slice(0, 32)
  const src = (projectId: string, icon: ProjectRepoIcon) =>
    `${REPO_ICON_PREFIX}${sign(projectId, icon.folder, icon.path)}/${[projectId, icon.folder, icon.path].map(encodeURIComponent).join('/')}${icon.opaque === true ? `?tile${icon.radius !== undefined ? `=${icon.radius}` : ''}` : icon.inset !== undefined ? `?inset=${icon.inset}` : ''}`

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
