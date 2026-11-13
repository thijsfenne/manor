import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { REMOTE_FAVICON_PATH, REMOTE_IMAGE_PATH, remoteImageUrl, webLinkOrigin, type ServerMessage, type ThreadEvent } from '@manor/contracts'

export const REMOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024
const FAVICON_MAX_BYTES = 256 * 1024
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
/** Addresses the proxy will fetch; the oldest is forgotten first. */
const MAX_KNOWN = 2_048
/** Sites whose icon answer is kept, and for how long: a found icon a day, a missing one an hour. */
const MAX_ICONS = 512
const ICON_TTL_MS = 24 * 60 * 60_000
const MISSING_ICON_TTL_MS = 60 * 60_000
/** Messages still streaming, and how much of each is kept to find an address split over deltas. */
const MAX_LIVE = 64
const LIVE_TAIL = 4_096

const ACCEPT = 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1'
const ICON_ACCEPT = 'image/x-icon,image/png,image/*;q=0.9,*/*;q=0.1'
const USER_AGENT = 'Mozilla/5.0 (compatible; Manor image proxy)'
const SERVED_TYPES = /^image\/(?:png|jpeg|gif|webp)(?:\s*;|$)/i

/**
 * `![alt](url "title")` with an http(s) destination. Balanced parentheses stay part of
 * the address, the way markdown reads `.../Bed_(insect).jpg`.
 */
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\(\s*(?:<(https?:\/\/[^<>\n]+)>|(https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/gi

/**
 * The site part of every web address in a message, written with a scheme or as GFM's
 * bare `www.` autolink (which markdown links as `http://`). Only the authority is read,
 * and the punctuation markdown leaves outside an autolink is trimmed off it, so the site
 * learned here is the one a rendered link asks for.
 */
const WEB_AUTHORITY = /\b(https?:\/\/|www\.)([^\s/?#<>()[\]{}"'`\\|]+)/gi
const TRAILING = /[.,:;!?*_~]+$/

/** Every site a message links to, as the origin a client asks for its icon by. */
export function linkedSites(text: string): string[] {
  if (!/http|www\./i.test(text)) return []
  const plain = unescapeMarkdown(text)
  const sites = new Set<string>()
  for (const match of plain.matchAll(WEB_AUTHORITY)) {
    const [whole, scheme, authority] = match
    // Punctuation is prose only where the address ends there; before a path it is the host's.
    const ends = !/[/?#]/.test(plain[match.index + whole.length] ?? '')
    const host = ends ? authority!.replace(TRAILING, '') : authority!
    const origin = webLinkOrigin(scheme!.toLowerCase() === 'www.' ? `http://www.${host}` : `${scheme}${host}`)
    if (origin !== undefined) sites.add(origin)
  }
  return [...sites]
}

/** Markdown's backslash escapes and the one entity an address commonly carries. */
const unescapeMarkdown = (url: string) => url.replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/&amp;/g, '&')

/** Every remote picture a message's markdown shows, in the spelling a client asks for. */
export function markdownImageUrls(text: string): string[] {
  if (!text.includes('![')) return []
  const urls: string[] = []
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const url = remoteImageUrl(unescapeMarkdown(match[1] ?? match[2] ?? ''))
    if (url !== undefined) urls.push(url)
  }
  return urls
}

/** A redirect's next address; a `Location` that does not parse ends the fetch instead of throwing. */
function redirectTarget(location: string, base: URL): string | undefined {
  try {
    return remoteImageUrl(new URL(location, base).href)
  } catch {
    return undefined
  }
}

const PRIVATE = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) PRIVATE.addSubnet(network, prefix, 'ipv6')

/**
 * Loopback, the LAN, the tailnet and every other address that is not the public internet.
 * An IPv4-mapped IPv6 address is judged by the IPv4 address inside it; a `::ffff:0:0/96`
 * rule would not do, because `BlockList` matches every IPv4 address against it.
 */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped !== undefined) return isPrivateAddress(mapped)
  const family = isIP(address)
  if (family === 6 && /^::ffff:/i.test(address)) return true
  return family === 0 || PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

/** How one kind of picture is fetched and which bytes it may be. */
interface Profile {
  accept: string
  maxBytes: number
  /** A site's own icon is often served as octet-stream or text, so its bytes decide alone. */
  trustHeader: boolean
  allowIcon: boolean
}

type Fetched =
  | { status: 'ok'; mime: string; bytes: Buffer }
  | { status: 'unknown' | 'refused' | 'not_image' | 'too_large' | 'failed' }

const UNKNOWN: Promise<Fetched> = Promise.resolve({ status: 'unknown' })
const FAILURE_STATUS = { unknown: 404, refused: 403, not_image: 415, too_large: 413, failed: 502 } as const

export interface RemoteImages {
  /** Every message a client receives passes here, so the proxy knows which addresses a message showed. */
  observe(message: ServerMessage): void
  /** Serves `REMOTE_IMAGE_PATH`; false when the request is something else. */
  handle(request: IncomingMessage, response: ServerResponse): boolean
}

/**
 * Remote pictures in chat markdown, fetched by the Mac and served on Manor's origin.
 *
 * The proxy fetches only an address a message on the wire actually showed, so it is no
 * open proxy for whoever can reach the port, and it needs no credential in the image
 * URL. It sends no cookies, no referrer and none of the client's headers, reaches only
 * public addresses (checked again on every redirect and at connect time, so DNS cannot
 * swap one in), and serves only PNG, JPEG, GIF and WebP whose bytes agree with their
 * declared type, up to `maxBytes`. SVG is refused: opened on its own it would be a page
 * on Manor's origin. What the proxy knows lives for one process; a restart
 * re-snapshots every open chat, which teaches it again.
 */
export function createRemoteImages(options: {
  allowPrivateHosts?: boolean
  maxBytes?: number
  timeoutMs?: number
  /** Tests name a site that resolves to their loopback upstream. */
  lookup?: typeof dnsLookup
} = {}): RemoteImages {
  const lookup = options.lookup ?? dnsLookup
  const allowPrivate = options.allowPrivateHosts === true
  const maxBytes = options.maxBytes ?? REMOTE_IMAGE_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const known = new Map<string, true>()
  const sites = new Map<string, true>()
  const icons = new Map<string, { fetched: Fetched; until: number }>()
  const picture: Profile = { accept: ACCEPT, maxBytes, trustHeader: true, allowIcon: false }
  const icon: Profile = { accept: ICON_ACCEPT, maxBytes: Math.min(maxBytes, FAVICON_MAX_BYTES), trustHeader: false, allowIcon: true }
  const live = new Map<string, string>()
  const inflight = new Map<string, Promise<Fetched>>()

  const learn = (into: Map<string, true>, keys: string[]) => {
    for (const key of keys) {
      into.delete(key)
      into.set(key, true)
      if (into.size > MAX_KNOWN) into.delete(into.keys().next().value!)
    }
  }
  const remember = (text: string) => {
    learn(known, markdownImageUrls(text))
    learn(sites, linkedSites(text))
  }

  const observeEvent = (chatId: string, event: ThreadEvent) => {
    if (event.type !== 'agent_message' && event.type !== 'user_message') return
    remember(event.text)
    if (event.type === 'agent_message' && event.messageId !== undefined) live.delete(`${chatId}:${event.messageId}`)
  }

  const guardedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
    lookup(hostname, { ...lookupOptions, all: true }, (error, addresses: LookupAddress[]) => {
      if (error !== null) {
        callback(error, '', 4)
        return
      }
      if (addresses.length === 0 || (!allowPrivate && addresses.some(({ address }) => isPrivateAddress(address)))) {
        callback(Object.assign(new Error('refused address'), { code: 'MANOR_REFUSED' }), '', 4)
        return
      }
      if (lookupOptions.all === true) (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses)
      else callback(null, addresses[0]!.address, addresses[0]!.family)
    })
  }

  const fetchOnce = (url: URL, redirects: number, profile: Profile): Promise<Fetched> => new Promise((resolve) => {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!allowPrivate && isIP(host) !== 0 && isPrivateAddress(host)) {
      resolve({ status: 'refused' })
      return
    }
    let settled = false
    const finish = (result: Fetched | Promise<Fetched>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const client = url.protocol === 'https:' ? https : http
    const request = client.get(url, { headers: { accept: profile.accept, 'user-agent': USER_AGENT }, lookup: guardedLookup }, (response) => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location !== undefined) {
        response.resume()
        const next = redirects < MAX_REDIRECTS ? redirectTarget(location, url) : undefined
        finish(next === undefined ? { status: 'failed' } : fetchOnce(new URL(next), redirects + 1, profile))
        return
      }
      if (status !== 200) {
        response.resume()
        finish({ status: 'failed' })
        return
      }
      if (profile.trustHeader && !SERVED_TYPES.test(response.headers['content-type'] ?? '')) {
        request.destroy()
        finish({ status: 'not_image' })
        return
      }
      if (Number(response.headers['content-length'] ?? 0) > profile.maxBytes) {
        request.destroy()
        finish({ status: 'too_large' })
        return
      }
      const chunks: Buffer[] = []
      let length = 0
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > profile.maxBytes) {
          request.destroy()
          finish({ status: 'too_large' })
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const bytes = Buffer.concat(chunks)
        const mime = imageMime(bytes, profile.allowIcon)
        finish(mime === undefined ? { status: 'not_image' } : { status: 'ok', mime, bytes })
      })
      response.on('error', () => finish({ status: 'failed' }))
    })
    request.on('error', (error: NodeJS.ErrnoException) => finish({ status: error.code === 'MANOR_REFUSED' ? 'refused' : 'failed' }))
    const timer = setTimeout(() => {
      request.destroy()
      finish({ status: 'failed' })
    }, timeoutMs)
  })

  const fetchShared = (url: string, profile: Profile) => {
    const key = `${profile.allowIcon ? 'icon' : 'picture'} ${url}`
    const running = inflight.get(key)
    if (running !== undefined) return running
    const started = fetchOnce(new URL(url), 0, profile).finally(() => inflight.delete(key))
    inflight.set(key, started)
    return started
  }

  /**
   * A site's `/favicon.ico`, the one address nearly every site still answers, asked of
   * the site itself so no third party learns which pages a chat cites. The answer is
   * kept, a missing icon included, so a reply full of sources costs each site one fetch.
   */
  const fetchIcon = async (site: string): Promise<Fetched> => {
    const kept = icons.get(site)
    if (kept !== undefined && kept.until > Date.now()) return kept.fetched
    const fetched = await fetchShared(`${site}/favicon.ico`, icon)
    icons.delete(site)
    icons.set(site, { fetched, until: Date.now() + (fetched.status === 'ok' ? ICON_TTL_MS : MISSING_ICON_TTL_MS) })
    if (icons.size > MAX_ICONS) icons.delete(icons.keys().next().value!)
    return fetched
  }

  const serve = (response: ServerResponse, fetched: Promise<Fetched>) => {
    const fail = (status: number) => {
      response.writeHead(status, { 'cache-control': 'no-store' })
      response.end()
    }
    void fetched.then((result) => {
      if (result.status !== 'ok') return fail(FAILURE_STATUS[result.status])
      response.writeHead(200, {
        'content-type': result.mime,
        'content-length': String(result.bytes.byteLength),
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; sandbox",
      })
      response.end(result.bytes)
    }).catch(() => {
      if (!response.headersSent) fail(502)
      else response.end()
    })
  }

  return {
    observe(message) {
      if (message.type === 'snapshot') for (const event of message.events) observeEvent(message.chatId, event)
      else if (message.type === 'event') observeEvent(message.chatId, message.event)
      else if (message.type === 'delta') {
        const key = `${message.chatId}:${message.messageId}`
        const text = (live.get(key) ?? '') + message.text
        remember(text)
        live.delete(key)
        live.set(key, text.slice(-LIVE_TAIL))
        if (live.size > MAX_LIVE) live.delete(live.keys().next().value!)
      }
    },
    handle(request, response) {
      let target: URL
      try {
        target = new URL(request.url ?? '/', 'http://manor')
      } catch {
        return false
      }
      if (target.pathname === REMOTE_FAVICON_PATH) {
        const site = target.searchParams.get('site') ?? ''
        const linked = request.method === 'GET' && webLinkOrigin(site) === site && sites.has(site)
        serve(response, linked ? fetchIcon(site) : UNKNOWN)
        return true
      }
      if (target.pathname !== REMOTE_IMAGE_PATH) return false
      const url = remoteImageUrl(target.searchParams.get('url') ?? '')
      if (request.method !== 'GET' || url === undefined || !known.has(url)) {
        serve(response, UNKNOWN)
        return true
      }
      serve(response, fetchShared(url, picture))
      return true
    },
  }
}

/** The type a picture's own bytes declare, for the four the proxy serves and, for a site icon, ICO. */
function imageMime(bytes: Buffer, allowIcon: boolean): string | undefined {
  const at = (offset: number, ...expected: number[]) => expected.every((value, index) => bytes[offset + index] === value)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (allowIcon && at(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon'
  return undefined
}
