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

const SEARCH_URL = 'https://www.google.com/search'

/**
 * Turns the address field into either a website navigation or a Google search, the way
 * Chrome's omnibox reads it. A domain with a real TLD, localhost or an IP is an address,
 * and gains its scheme here: `localhost:3000` would otherwise read as scheme `localhost:`.
 * Text with a space, or a single word, searches. Other schemes stay for the host to judge.
 */
export function resolveBrowserAddress(raw: string): string {
  const value = raw.trim()
  if (value === '') return ''

  const website = websiteAddress(value)
  if (website !== null) return website
  if (EXPLICIT_SCHEME.test(value) && !/\s/.test(value)) return value
  return googleSearchUrl(value)
}

/** The Google results page for this text, even when it reads as an address. */
export function googleSearchUrl(text: string): string {
  const search = new URL(SEARCH_URL)
  search.searchParams.set('q', text.trim())
  return search.href
}

/** Whether Enter on this text searches Google rather than opening it. */
export function addressSearches(raw: string): boolean {
  return resolveBrowserAddress(raw).startsWith(`${SEARCH_URL}?`)
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
