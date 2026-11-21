import { imageEmbeds, resolveVaultImage, VAULT_IMAGE_PATH } from '@manor/contracts'

/** What a note needs to turn a picture embed into a link the Mac serves. */
export interface VaultPictures {
  /** Vault path to signed relative URL, as the vault listing delivers it. */
  images: Readonly<Record<string, string>>
  /** Obsidian's `attachmentFolderPath` as written, or null when the vault sets none. */
  attachmentFolder: string | null
}

/** Marks the stored width on a rewritten picture's address; `noteImageWidth` reads it back. */
const WIDTH_KEY = '#manor-width='
const WIDTH = /^(.*)#manor-width=(\d{1,5})$/s

/** Character offsets of the fenced code blocks in `text`, which keep their embeds as written. */
function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  let open: { fence: string; from: number } | undefined
  let offset = 0
  for (const line of text.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence !== undefined) {
      if (open === undefined) open = { fence: fence[0]!, from: offset }
      else if (fence[0] === open.fence) {
        ranges.push([open.from, offset + line.length])
        open = undefined
      }
    }
    offset += line.length + 1
  }
  if (open !== undefined) ranges.push([open.from, text.length])
  return ranges
}

/** True for an offset inside an open inline code span: an odd number of backticks earlier on its line. */
function insideInlineCode(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  return (text.slice(lineStart, at).match(/`/g)?.length ?? 0) % 2 === 1
}

/** A markdown destination in angle brackets, which may hold spaces and parentheses. */
const destination = (url: string) => `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`

/**
 * A note's markdown with each picture embed that resolves in the vault rewritten as a
 * standard picture whose address is the signed link, carrying a stored width after
 * `#manor-width=`. The Markdown component then draws it as a picture block. An embed no
 * listed picture matches, and one inside code, stays as written.
 */
export function withVaultPictures(text: string, notePath: string, pictures: VaultPictures): string {
  const embeds = imageEmbeds(text)
  if (embeds.length === 0) return text
  const fenced = fencedRanges(text)
  const setting = pictures.attachmentFolder ?? undefined
  let out = text
  for (const embed of embeds.slice().reverse()) {
    if (fenced.some(([from, to]) => embed.from >= from && embed.from < to) || insideInlineCode(text, embed.from)) continue
    const path = resolveVaultImage(embed.target, notePath, pictures.images, setting)
    const url = path === undefined ? undefined : pictures.images[path]
    if (url === undefined || !url.startsWith(VAULT_IMAGE_PATH)) continue
    const alt = embed.alt !== '' ? embed.alt : embed.target.slice(embed.target.lastIndexOf('/') + 1)
    const address = destination(embed.width === undefined ? url : `${url}${WIDTH_KEY}${embed.width}`)
    out = `${out.slice(0, embed.from)}![${alt}](${address})${out.slice(embed.to)}`
  }
  return out
}

/** A rewritten picture's address split into the link the Mac serves and the width stored with it. */
export function noteImageWidth(src: string): { src: string; width?: number } {
  const match = WIDTH.exec(src)
  return match === null ? { src } : { src: match[1]!, width: Number(match[2]) }
}
