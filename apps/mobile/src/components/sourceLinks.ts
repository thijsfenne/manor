import { webLinkOrigin } from '@manor/contracts'

/**
 * One item that is nothing but a link, spelled the way `Inline` reads one, or a bare
 * address. A bare address ending in punctuation is not link-only: the punctuation is
 * prose, as on the Mac, so the item keeps its bullet and its link reads as a pill.
 */
const LINK_ONLY = /^\[(?!!\[)[^\]\n]+\]\(([^)\s]+)\)$|^<(https?:\/\/[^\s<>)]+)>$|^(https?:\/\/[^\s<>)]*[^\s<>).,:;!?*_~])$/

/**
 * The address of a bullet item that is nothing but one web link, which is how a reply
 * writes its Sources list. The Mac applies the same rule to the parsed item
 * (`apps/web/src/sourceLinks.ts`), so both draw the site's icon in place of the bullet.
 */
export function sourceItemHref(text: string): string | undefined {
  const match = LINK_ONLY.exec(text.trim())
  const href = match?.[1] ?? match?.[2] ?? match?.[3]
  return webLinkOrigin(href) === undefined ? undefined : href
}
