/**
 * Pictures inside Knowledge notes. The file stays plain Obsidian markdown: an embed is
 * `![[name.png]]`, `![[name.png|400]]`, `![alt](path.png)` or `![alt|400](path.png)`,
 * and the width after the bar is what Obsidian reads too. The server lists every picture
 * in the vault with a signed link (`vault_files.images`), so both clients resolve an embed
 * the way Obsidian does without a round trip, and the page CSP stays closed.
 */

/** Where the Manor server serves one vault picture: `<prefix><signature>/<path>`. */
export const VAULT_IMAGE_PATH = '/media/vault/'

/** Picture types both clients can draw. TIFF, HEIC and SVG are left out on purpose. */
export const VAULT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] as const

/** The largest picture a paste or drop may save, in bytes. */
export const MAX_VAULT_IMAGE_BYTES = 20 * 1024 * 1024

/** The longest file name a save carries; the editor saves a longer dropped name as a pasted one. */
export const MAX_VAULT_IMAGE_NAME = 200

export const isVaultImagePath = (path: string): boolean => {
  const dot = path.lastIndexOf('.')
  return dot > 0 && (VAULT_IMAGE_EXTENSIONS as readonly string[]).includes(path.slice(dot + 1).toLowerCase())
}

/** One picture embed found in a line of markdown. Offsets are relative to the text searched. */
export interface ImageEmbed {
  kind: 'wiki' | 'markdown'
  from: number
  to: number
  /** The link as written, decoded: a name, a vault path or a path relative to the note. */
  target: string
  alt: string
  /** Pixels from `|400` or `|400x300`; undefined when the embed names no size. */
  width?: number
  height?: number
}

const WIKI_EMBED = /!\[\[([^[\]\n|#^]+)(?:#[^[\]\n|]*)?((?:\|[^[\]\n|]*)*)\]\]/g
const MARKDOWN_EMBED = /!\[([^\]\n]*)\]\(\s*(?:<([^<>\n]+)>|([^\s()<>]+))(?:\s+"[^"\n]*")?\s*\)/g
const SIZE = /^\s*(\d{1,5})(?:x(\d{1,5}))?\s*$/

function splitSize(parts: string[]): { alt: string; width?: number; height?: number } {
  const last = parts.at(-1)
  const size = last === undefined ? null : SIZE.exec(last)
  if (size === null) return { alt: parts.join('|').trim() }
  return {
    alt: parts.slice(0, -1).join('|').trim(),
    width: Number(size[1]),
    ...(size[2] === undefined ? {} : { height: Number(size[2]) }),
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Every picture embed in `text`. Remote addresses and links to anything but a picture
 * are skipped, so a `![[Other note]]` transclusion stays text.
 */
export function imageEmbeds(text: string): ImageEmbed[] {
  if (!text.includes('![')) return []
  const found: ImageEmbed[] = []
  for (const match of text.matchAll(WIKI_EMBED)) {
    const target = match[1]!.trim()
    if (!isVaultImagePath(target)) continue
    const parts = match[2] === undefined || match[2] === '' ? [] : match[2].slice(1).split('|')
    found.push({ kind: 'wiki', from: match.index, to: match.index + match[0].length, target, ...splitSize(parts) })
  }
  for (const match of text.matchAll(MARKDOWN_EMBED)) {
    const raw = match[2] ?? match[3] ?? ''
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue
    const target = safeDecode(raw)
    if (!isVaultImagePath(target)) continue
    found.push({ kind: 'markdown', from: match.index, to: match.index + match[0].length, target, ...splitSize(match[1]!.split('|')) })
  }
  return found.sort((left, right) => left.from - right.from)
}

/**
 * The embed rewritten with a new width, in the syntax it already used, so Obsidian shows
 * the same size. A height it carried goes: a width alone keeps the picture's own ratio.
 */
export function embedWithWidth(source: string, embed: ImageEmbed, width: number): string {
  const text = source.slice(embed.from, embed.to)
  const size = String(Math.round(width))
  if (embed.kind === 'wiki') {
    const close = text.lastIndexOf(']]')
    const inner = text.slice(3, close)
    const parts = inner.split('|')
    const head = parts[0]!
    const rest = parts.slice(1)
    if (rest.length > 0 && SIZE.test(rest.at(-1)!)) rest.pop()
    return `![[${[head, ...rest, size].join('|')}]]`
  }
  const altEnd = text.indexOf('](')
  const alt = text.slice(2, altEnd)
  const parts = alt.split('|')
  if (parts.length > 1 && SIZE.test(parts.at(-1)!)) parts.pop()
  const keep = parts.join('|')
  return `![${keep === '' ? '' : `${keep}|`}${size}${text.slice(altEnd)}`
}

/**
 * Obsidian's attachment folder for a note, as a vault path (`''` is the root). `setting`
 * is `attachmentFolderPath` from `.obsidian/app.json`: absent or `/` is the root, `./` the
 * note's own folder, `./x` a folder under it, anything else a folder from the root.
 */
export function attachmentFolderFor(setting: string | undefined, notePath: string): string {
  const noteFolder = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const value = (setting ?? '').trim()
  if (value === '' || value === '/') return ''
  if (value === '.' || value === './') return noteFolder
  if (value.startsWith('./')) return joinVaultPath(noteFolder, value.slice(2))
  return joinVaultPath('', value)
}

/** `/`-joined and normalised, with `..` folded; `'\0'`, which names no file, when it climbs out of the vault. */
function joinVaultPath(base: string, relative: string): string {
  const out = base === '' ? [] : base.split('/')
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return '\0'
      out.pop()
    } else out.push(part)
  }
  return out.join('/')
}

/**
 * The vault path an embed shows, or undefined when no listed picture matches. Tried in
 * order: the path as written relative to the note, the path from the vault root, the
 * note's attachment folder, then the shortest vault path with the same file name, which
 * is how Obsidian settles a bare name.
 */
export function resolveVaultImage(
  target: string,
  notePath: string,
  images: Readonly<Record<string, string>>,
  attachmentSetting?: string,
): string | undefined {
  const clean = target.trim().replace(/^\/+/, '')
  if (clean === '') return undefined
  const noteFolder = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const name = clean.slice(clean.lastIndexOf('/') + 1)
  const candidates = [
    joinVaultPath(noteFolder, clean),
    joinVaultPath('', clean),
    joinVaultPath(attachmentFolderFor(attachmentSetting, notePath), name),
  ]
  for (const candidate of candidates) {
    if (images[candidate] !== undefined) return candidate
  }
  const lower = name.toLowerCase()
  let best: string | undefined
  for (const path of Object.keys(images)) {
    const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
    if (base !== lower) continue
    if (best === undefined || path.length < best.length) best = path
  }
  return best
}
