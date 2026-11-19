import type { BrowserSearchEngine } from '@manor/contracts'
import { TOP_LEVEL_DOMAINS } from './browserTlds'

const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:/i

/** A tab URL as the address bar shows it. A fresh tab's own blank page reads as empty. */
export function shownAddress(url: string): string {
  return url.startsWith('about:blank') ? '' : url
}

/**
 * A web address split around its site, the part the resting address bar shows:
 * `https://www.example.com/pricing` rests as `example.com`. The pieces join
 * back into the exact address, so the site can slide to where it sits in the full
 * one. Null for anything that is not a web page, which then shows as it is.
 */
export function addressParts(url: string): { before: string; site: string; after: string } | null {
  if (!/^https?:\/\//i.test(url)) return null
  let host: string
  try { host = new URL(url).host } catch { return null }
  const site = host.replace(/^www\./i, '')
  if (site === '') return null
  const start = url.toLowerCase().indexOf(site.toLowerCase(), url.indexOf('//') + 2)
  if (start < 0) return null
  return { before: url.slice(0, start), site: url.slice(start, start + site.length), after: url.slice(start + site.length) }
}

/**
 * Each engine the address bar can search with: the name rows and Settings show, and the
 * results page the typed words go to as its `q` parameter.
 */
export const SEARCH_ENGINES: Record<BrowserSearchEngine, { label: string; url: string }> = {
  google: { label: 'Google', url: 'https://www.google.com/search' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search' },
  brave: { label: 'Brave Search', url: 'https://search.brave.com/search' },
  ecosia: { label: 'Ecosia', url: 'https://www.ecosia.org/search' },
  kagi: { label: 'Kagi', url: 'https://kagi.com/search' },
}

/** What Enter does with the address field: open this address, or search for this text. */
type AddressReading = { kind: 'open'; url: string } | { kind: 'search'; text: string }

/**
 * Reads the address field as a website navigation or a search. A domain with a real TLD,
 * localhost or an IP is an address, and gains its scheme here: `localhost:3000` would
 * otherwise read as scheme `localhost:`. Text with a space, or a single word, searches.
 * Other schemes stay for the host to judge. Null for an empty field.
 */
function readAddress(raw: string): AddressReading | null {
  const value = raw.trim()
  if (value === '') return null

  const website = websiteAddress(value)
  if (website !== null) return { kind: 'open', url: website }
  if (EXPLICIT_SCHEME.test(value) && !/\s/.test(value)) return { kind: 'open', url: value }
  return { kind: 'search', text: value }
}

/** Where Enter on the address field goes: the address itself, or the engine's results for the text. */
export function resolveBrowserAddress(raw: string, engine: BrowserSearchEngine): string {
  const reading = readAddress(raw)
  if (reading === null) return ''
  return reading.kind === 'open' ? reading.url : searchUrl(reading.text, engine)
}

/** The engine's results page for this text, even when it reads as an address. */
export function searchUrl(text: string, engine: BrowserSearchEngine): string {
  const search = new URL(SEARCH_ENGINES[engine].url)
  search.searchParams.set('q', text.trim())
  return search.href
}

/** Whether Enter on this text searches rather than opening it, whichever engine searches. */
export function addressSearches(raw: string): boolean {
  return readAddress(raw)?.kind === 'search'
}

function websiteAddress(value: string): string | null {
  if (/\s/.test(value)) return null
  if (/^https?:\/\//i.test(value)) return value
  if (EXPLICIT_SCHEME.test(value) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(value)) return null

  let url: URL
  try { url = new URL(`http://${value}`) } catch { return null }
  if (url.username !== '' || url.password !== '') return null
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const typedHost = value.split(/[/?#]/)[0]!.replace(/:\d+$/, '')
  // Local and numeric hosts rarely serve https, so they open over http as Chrome does.
  if (hostname === 'localhost' || /\.(?:localhost|local)$/.test(hostname) || hostname.startsWith('[')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(typedHost)) return `http://${value}`
  const tld = hostname.split('.').at(-1) ?? ''
  return hostname.includes('.') && TOP_LEVEL_DOMAINS.has(tld) ? `https://${value}` : null
}
