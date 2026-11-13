import { isSingleUseConnectLink } from './connectCard.js'

/**
 * Where the Manor server serves a picture a message linked from another site. Same
 * origin as the page, so the page CSP stays closed to every other image host, and
 * the phone reaches it through the Mac it already talks to.
 */
export const REMOTE_IMAGE_PATH = '/media/remote'

const MAX_URL_CHARS = 2_000
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i

/**
 * The one spelling of a remote picture's address both ends compare: the server when it
 * learns the address from a message, a client when it asks for it. Undefined for
 * anything but plain http(s), and for an address carrying a user name or password,
 * which the proxy would otherwise hand to a third party.
 */
export function remoteImageUrl(src: string): string | undefined {
  if (src.length > MAX_URL_CHARS) return undefined
  try {
    const url = new URL(src.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.href
  } catch {
    return undefined
  }
}

/**
 * What a client loads for a markdown image: a remote picture through the server's
 * proxy, a raster data URL as itself. Undefined means the picture cannot be shown
 * (a blob, a relative path, SVG data, a single-use sign-in link) and the client
 * renders its fallback instead.
 */
export function markdownImageSource(src: string | undefined): string | undefined {
  if (src === undefined || src === '' || isSingleUseConnectLink(src)) return undefined
  if (RASTER_DATA_URL.test(src)) return src
  const url = remoteImageUrl(src)
  return url === undefined ? undefined : `${REMOTE_IMAGE_PATH}?url=${encodeURIComponent(url)}`
}
