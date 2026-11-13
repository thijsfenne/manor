import type { BrowserAddressMatches, BrowserHistoryEntry, BrowserTabState } from '@manor/contracts'
import { addressSearches, resolveBrowserAddress } from './browserAddress'

/**
 * One row under the address field. A site is a host at its root; `search` and
 * `address` are what was typed, searched or opened as it is; a tab is already open.
 */
export type AddressSuggestion =
  | { kind: 'site'; key: string; url: string; title: string; favicon?: string }
  | { kind: 'search'; key: 'search'; text: string }
  | { kind: 'address'; key: 'address'; text: string }
  | { kind: 'visit'; key: string; entry: BrowserHistoryEntry }
  | { kind: 'tab'; key: string; tab: BrowserTabState }

/** The grey rest of the address the typed text grows into, and where Enter then goes. */
export interface AddressCompletion {
  rest: string
  url: string
  title: string
  favicon?: string
}

export interface AddressPlan {
  rows: AddressSuggestion[]
  /** Set while inline completion shows; its site is then the first row. */
  completion?: AddressCompletion
}

const VISIBLE_ROWS = 8
const OTHER_SITES = 2
const OPEN_TABS = 2
// A query longer than this, typically a sign-in or tracking tail, is not shown.
const SHOWN_QUERY = 40
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i
// Query keys that carry one-time codes or credentials. Such an address is never offered.
const SECRET_KEY = /^(code|token|access_token|id_token|refresh_token|auth_token|oauth_token|oauth_verifier|session|session_?id|sid|state|nonce|otp|ticket|password|passwd|secret|client_secret|signature|sig|key|api_?key|samlresponse|jwt)$/i

/** An address without its scheme or `www.`, which is how people type one. */
function bare(url: string): string {
  return url.replace(SCHEME, '').replace(/^www\./i, '')
}

/** The address as a row shows it: no scheme or `www.`, no lone root slash, no long query. */
export function shownUrl(url: string): string {
  let parsed: URL
  try { parsed = new URL(url) } catch { return url }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url
  const tail = parsed.search + parsed.hash
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  return bare(`${parsed.host}${path}${tail.length > SHOWN_QUERY ? '' : tail}`)
}

/** Whether a row would hide this address's query, so the grey completion may not spell it out. */
function longTail(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.search.length + parsed.hash.length > SHOWN_QUERY
  } catch {
    return true
  }
}

/** A sign-in callback or any address carrying a code or token in its query. */
export function carriesSecret(url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return true }
  if (parsed.username !== '' || parsed.password !== '' || /callback/i.test(parsed.pathname)) return true
  // A fragment holds keys directly (`#access_token=`) or behind a hash route (`#/done?code=`).
  const fragment = parsed.hash.slice(1)
  const keys = [
    ...parsed.searchParams.keys(),
    ...new URLSearchParams(fragment).keys(),
    ...new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1)).keys(),
  ]
  return keys.some((key) => SECRET_KEY.test(key))
}

/** A page title without the unread counter some sites put in front, such as "(99+) ". */
export function cleanTitle(title: string): string {
  return title.replace(/^\(\d+\+?\)\s*/, '').trim()
}

/**
 * Every site the matches know of by its bare host. The desktop sends sites with all
 * their visits summed; an older shell sends pages only, which then stand in for theirs.
 */
function knownSites(matches: BrowserAddressMatches): Map<string, BrowserHistoryEntry> {
  const sites = new Map<string, BrowserHistoryEntry>()
  for (const site of matches.sites) sites.set(bare(site.url).replace(/\/$/, '').toLowerCase(), site)
  const derived = new Map<string, BrowserHistoryEntry>()
  for (const page of matches.pages) {
    let parsed: URL
    try { parsed = new URL(page.url) } catch { continue }
    const host = parsed.host.replace(/^www\./, '')
    if (sites.has(host)) continue
    const root = `${parsed.origin}/`
    const known = derived.get(host)
    const favicon = known?.favicon ?? page.favicon
    derived.set(host, {
      url: known?.url ?? root,
      title: page.url === root ? page.title : known?.title ?? '',
      visitCount: (known?.visitCount ?? 0) + page.visitCount,
      lastVisitedAt: Math.max(known?.lastVisitedAt ?? 0, page.lastVisitedAt),
      ...(favicon === undefined ? {} : { favicon }),
    })
  }
  return new Map([...sites, ...derived])
}

const mostVisited = (a: BrowserHistoryEntry, b: BrowserHistoryEntry) => b.visitCount - a.visitCount

/**
 * What the typed text completes to, as in Chrome: a host it starts, at the host's root,
 * the most visited first, so "twitc" grows into "twitch.tv" however often a channel
 * page was opened. Only text that already reaches past the host completes into a page.
 * Text with a space never completes.
 */
export function inlineCompletion(typed: string, matches: BrowserAddressMatches): AddressCompletion | undefined {
  if (typed === '' || /\s/.test(typed)) return undefined
  const prefix = bare(typed).toLowerCase()
  if (prefix === '') return undefined
  const sites = knownSites(matches)
  if (!prefix.includes('/')) {
    const best = [...sites]
      .filter(([host]) => host.startsWith(prefix))
      .sort(([, a], [, b]) => mostVisited(a, b))[0]
    if (best === undefined) return undefined
    const [host, site] = best
    return { rest: host.slice(prefix.length), url: site.url, title: cleanTitle(site.title) || host, ...favicon(site) }
  }
  const page = [...sites.values(), ...matches.pages]
    .filter((entry) => !carriesSecret(entry.url) && !longTail(entry.url) && bare(entry.url).toLowerCase().startsWith(prefix))
    .sort(mostVisited)[0]
  if (page === undefined) return undefined
  return { rest: bare(page.url).slice(prefix.length), url: page.url, title: cleanTitle(page.title) || shownUrl(page.url), ...favicon(page) }
}

function favicon(entry: { favicon?: string }): { favicon?: string } {
  return entry.favicon === undefined ? {} : { favicon: entry.favicon }
}

/** Whether a visit or tab answers the typed text by address or title, scheme and `www.` aside. */
function answers(url: string, title: string, text: string): boolean {
  return bare(url).toLowerCase().includes(bare(text).toLowerCase()) || title.toLowerCase().includes(text.toLowerCase())
}

const siteRow = (url: string, title: string, icon: { favicon?: string }): AddressSuggestion =>
  ({ kind: 'site', key: `site:${url}`, url, title, ...icon })

/**
 * The rows for what is typed, in Chrome's order: the completed site, then the Google
 * search, then other sites, open tabs and pages. Without a completion the typed text
 * leads, opened as an address when it is one. `completing` is false right after a
 * deletion, so Backspace removes the completion instead of bringing it straight back.
 * Visits that no longer answer the text are dropped, so a slower answer for an earlier
 * prefix never shows. An empty field lists recent visits only.
 */
export function planAddress(
  typed: string,
  matches: BrowserAddressMatches,
  tabs: readonly BrowserTabState[] = [],
  completing = true,
): AddressPlan {
  const text = typed.trim()
  const pages = matches.pages.filter((entry) => !carriesSecret(entry.url))
  if (text === '') {
    return { rows: pages.slice(0, VISIBLE_ROWS).map((entry) => ({ kind: 'visit', key: entry.url, entry })) }
  }

  const completion = completing ? inlineCompletion(typed, matches) : undefined
  const search: AddressSuggestion = { kind: 'search', key: 'search', text }
  const rows: AddressSuggestion[] = completion !== undefined
    ? [siteRow(completion.url, completion.title, completion), search]
    : addressSearches(text) ? [search] : [{ kind: 'address', key: 'address', text }, search]
  const taken = new Set(completion === undefined ? [resolveBrowserAddress(text)] : [completion.url])

  const prefix = bare(text).toLowerCase().split('/')[0]!
  const sites = /\s/.test(text) ? [] : [...knownSites(matches)]
    .filter(([host, site]) => host.startsWith(prefix) && !taken.has(site.url))
    .sort(([, a], [, b]) => mostVisited(a, b))
    // Without a completion the best site has no row yet, as right after Backspace.
    .slice(0, completion === undefined ? OTHER_SITES + 1 : OTHER_SITES)
  for (const [host, site] of sites) {
    taken.add(site.url)
    rows.push(siteRow(site.url, cleanTitle(site.title) || host, site))
  }
  const openTabs = tabs.filter((tab) => !carriesSecret(tab.url) && !taken.has(tab.url) && answers(tab.url, tab.title, text))
  for (const tab of openTabs.slice(0, OPEN_TABS)) {
    taken.add(tab.url)
    rows.push({ kind: 'tab', key: `tab:${tab.id}`, tab })
  }
  for (const entry of pages) {
    if (rows.length >= VISIBLE_ROWS) break
    if (taken.has(entry.url) || !answers(entry.url, entry.title, text)) continue
    taken.add(entry.url)
    rows.push({ kind: 'visit', key: entry.url, entry })
  }
  return { rows: rows.slice(0, VISIBLE_ROWS), ...(completion === undefined ? {} : { completion }) }
}

/** Where the first case-insensitive occurrence of the typed text sits, for bolding. */
export function matchSpan(text: string, typed: string): [number, number] | null {
  const needle = bare(typed.trim()).toLowerCase()
  if (needle === '') return null
  const start = text.toLowerCase().indexOf(needle)
  return start < 0 ? null : [start, start + needle.length]
}
