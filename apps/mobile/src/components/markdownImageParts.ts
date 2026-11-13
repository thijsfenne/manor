/**
 * A destination the way the server's image proxy reads one, so the phone asks for the
 * address the proxy learned: `<...>` may hold spaces, balanced parentheses stay part of
 * the address, and a title after it is dropped.
 */
const DESTINATION = String.raw`\(\s*(?:<([^<>\n]+)>|((?:[^\s()<>]|\([^\s()<>]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)`
const IMAGE = new RegExp(String.raw`\[!\[([^\]\n]*)\]${DESTINATION}\]${DESTINATION}|!\[([^\]\n]*)\]${DESTINATION}`, 'g')

/** Markdown's backslash escapes and the one entity an address commonly carries. */
const unescapeMarkdown = (url: string) => url.replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/&amp;/g, '&')

export type ImagePart = { kind: 'text'; text: string } | { kind: 'image'; alt: string; src: string; href?: string }

/**
 * A paragraph cut around its pictures, or undefined when it has none. `href` is the link
 * a picture sits inside. A picture written inside inline code (an odd number of
 * backticks before it) stays code.
 */
export function imageParts(text: string): ImagePart[] | undefined {
  if (!text.includes('![')) return undefined
  const parts: ImagePart[] = []
  let last = 0
  for (const match of text.matchAll(IMAGE)) {
    const at = match.index ?? 0
    if ((text.slice(0, at).match(/`/g)?.length ?? 0) % 2 === 1) continue
    const before = text.slice(last, at).trim()
    if (before !== '') parts.push({ kind: 'text', text: before })
    parts.push(match[1] === undefined
      ? { kind: 'image', alt: match[6] ?? '', src: unescapeMarkdown(match[7] ?? match[8] ?? '') }
      : { kind: 'image', alt: match[1], src: unescapeMarkdown(match[2] ?? match[3] ?? ''), href: unescapeMarkdown(match[4] ?? match[5] ?? '') })
    last = at + match[0].length
  }
  if (parts.length === 0) return undefined
  const after = text.slice(last).trim()
  if (after !== '') parts.push({ kind: 'text', text: after })
  return parts
}
