/**
 * Where the Manor server serves a linked site's icon. Same origin as the page, like
 * `REMOTE_IMAGE_PATH`, so the page CSP stays closed and the phone asks the Mac.
 */
export const REMOTE_FAVICON_PATH = '/media/favicon'

const MAX_URL_CHARS = 2_000
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/

/**
 * The site a written link points at, when it is a page on the public web: plain
 * http(s) to a dotted host name. Undefined for mail, files, relative paths and the
 * machine's own or LAN addresses (`localhost`, `*.local`, IP literals), which is what
 * keeps Manor's own links and a dev server out of the source styling.
 */
export function webLinkOrigin(href: string | undefined): string | undefined {
  if (href === undefined || href.length > MAX_URL_CHARS) return undefined
  try {
    const url = new URL(href.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    const host = url.hostname
    if (!host.includes('.') || host.startsWith('[') || IPV4.test(host)) return undefined
    if (host.endsWith('.localhost') || host.endsWith('.local')) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/** What a client loads for a web link's icon, or undefined when the link is not a web page. */
export function faviconSource(href: string | undefined): string | undefined {
  const origin = webLinkOrigin(href)
  return origin === undefined ? undefined : `${REMOTE_FAVICON_PATH}?site=${encodeURIComponent(origin)}`
}
