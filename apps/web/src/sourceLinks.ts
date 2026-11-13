import { webLinkOrigin } from '@manor/contracts'
import type { ExtraProps } from 'react-markdown'

type HastNode = NonNullable<ExtraProps['node']>
type HastChild = HastNode['children'][number]

/** Children that carry something: the whitespace text a parser leaves between tags does not. */
const solid = (node: HastNode | HastChild): HastChild[] =>
  'children' in node ? node.children.filter((child) => !(child.type === 'text' && child.value.trim() === '')) : []

const hasImage = (node: HastChild): boolean =>
  node.type === 'element' && (node.tagName === 'img' || node.children.some(hasImage))

/**
 * A link written to a web page, as opposed to a mail address, a file or a linked
 * picture. These are the links a reply cites, and they read as sources.
 */
export function isSourceLink(href: string | undefined, node: HastNode | undefined): boolean {
  return webLinkOrigin(href) !== undefined && (node === undefined || !node.children.some(hasImage))
}

/**
 * The address of a bullet item that is nothing but one web link (`- [Healio](https://...)`
 * or a bare `- https://...`), which is how a reply writes its Sources list. Judged per
 * item rather than per list, so a list still being written gets its marks as each item
 * lands and never flips when the list closes. A loose list wraps the link in a
 * paragraph, which changes nothing.
 */
export function sourceItemHref(item: HastNode | undefined): string | undefined {
  if (item === undefined) return undefined
  let only = solid(item)
  if (only.length === 1 && only[0]!.type === 'element' && only[0]!.tagName === 'p') only = solid(only[0]!)
  const link = only.length === 1 ? only[0]! : undefined
  if (link?.type !== 'element' || link.tagName !== 'a') return undefined
  const href = link.properties.href
  return typeof href === 'string' && isSourceLink(href, link) ? href : undefined
}
