import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { BrowserAddressMatches, BrowserHistoryEntry } from '@manor/contracts'
import type { StatementSync } from 'node:sqlite'

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')

const IMPORTED_SOURCE = 'dia'
const MANOR_SOURCE = 'manor'
const MAX_IMPORTED_ENTRIES = 50_000
const MAX_RESULTS = 8
const MAX_SITES = 4
// Extra pages so the address bar still has eight after dropping sign-in callbacks.
const MAX_ADDRESS_PAGES = 24
const DAY_MS = 86_400_000
const CANDIDATES = 200
// Sorts after every character a host can hold, so `site < prefix + this` ends a prefix range.
const RANGE_END = '\u{10FFFF}'
const CHROMIUM_TO_UNIX_EPOCH_MS = 11_644_473_600_000n

export interface BrowserHistory {
  record(url: string, title: string): void
  updateTitle(url: string, title: string): void
  /** A site's mark, kept per host after its tabs close. */
  recordFavicon(url: string, favicon: string): void
  favicon(url: string): string | undefined
  search(query?: string): BrowserHistoryEntry[]
  addressMatches(query: string): BrowserAddressMatches
  replaceImported(profilePath: string): void
  clearImported(): void
  clearAll(): void
}

export const emptyBrowserHistory: BrowserHistory = {
  record: () => {},
  updateTitle: () => {},
  recordFavicon: () => {},
  favicon: () => undefined,
  search: () => [],
  addressMatches: () => ({ sites: [], pages: [] }),
  replaceImported: () => {},
  clearImported: () => {},
  clearAll: () => {},
}

/**
 * Manor-owned browsing history. The browser the user copies logins from contributes
 * a replaceable read-only snapshot, stored under the source name `dia` from when Dia
 * was the only such browser;
 * Manor visits remain in this database when that Chromium profile is refreshed.
 */
export class BrowserHistoryStore implements BrowserHistory {
  private readonly database: InstanceType<typeof DatabaseSync>
  private readonly searchStatement: StatementSync
  private readonly faviconStatement: StatementSync
  private readonly sitesStatement: StatementSync
  private readonly pagesStatement: StatementSync
  private readonly titleStatement: StatementSync

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true })
    this.database = new DatabaseSync(filePath)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS browser_history (
        source TEXT NOT NULL CHECK (source IN ('dia', 'manor')),
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        visit_count INTEGER NOT NULL DEFAULT 1,
        last_visited_at INTEGER NOT NULL,
        PRIMARY KEY (source, url)
      );
      CREATE INDEX IF NOT EXISTS browser_history_recent
        ON browser_history(last_visited_at DESC);
      CREATE INDEX IF NOT EXISTS browser_history_url_recent
        ON browser_history(url, last_visited_at DESC);
      CREATE TABLE IF NOT EXISTS browser_favicons (
        host TEXT PRIMARY KEY,
        favicon TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    this.addSiteColumns()
    this.faviconStatement = this.database.prepare('SELECT favicon FROM browser_favicons WHERE host = ?')
    // Each URL has at most two source rows, so sixteen matches include the eight
    // newest distinct URLs. Aggregate only those candidates, including older duplicates.
    this.searchStatement = this.database.prepare(`
      WITH candidates AS (
        SELECT url FROM browser_history
        WHERE (? = '' OR lower(url) LIKE ? ESCAPE '\\'
          OR lower(title) LIKE ? ESCAPE '\\')
        ORDER BY last_visited_at DESC
        LIMIT ${MAX_RESULTS * 2}
      )
      SELECT grouped.url,
        COALESCE((
          SELECT newer.title FROM browser_history AS newer
          WHERE newer.url = grouped.url AND newer.title <> ''
          ORDER BY newer.last_visited_at DESC LIMIT 1
        ), '') AS title,
        SUM(grouped.visit_count) AS visit_count,
        MAX(grouped.last_visited_at) AS last_visited_at
      FROM browser_history AS grouped
      WHERE grouped.url IN (SELECT url FROM candidates)
        AND (? = '' OR lower(grouped.url) LIKE ? ESCAPE '\\'
        OR lower(grouped.title) LIKE ? ESCAPE '\\')
      GROUP BY grouped.url
      ORDER BY last_visited_at DESC
      LIMIT ${MAX_RESULTS}
    `)
    // A site is a host without `www.`, its origin the scheme and host as visited. The
    // covering index keeps a one-letter prefix a range read rather than a table scan.
    // Sites rank by all their visits; each is rooted at its most visited origin, so
    // `www.` and scheme variants fold into one row before the limit applies.
    this.sitesStatement = this.database.prepare(`
      WITH variants AS (
        SELECT site, origin, SUM(visit_count) AS visits, MAX(last_visited_at) AS last_visit
        FROM browser_history
        WHERE site >= :from AND site < :until
        GROUP BY site, origin
      ), ranked AS (
        SELECT origin,
          SUM(visits) OVER (PARTITION BY site) AS visit_count,
          MAX(last_visit) OVER (PARTITION BY site) AS last_visited_at,
          ROW_NUMBER() OVER (PARTITION BY site ORDER BY visits DESC) AS variant
        FROM variants
      )
      SELECT origin, visit_count, last_visited_at FROM ranked
      WHERE variant = 1
      ORDER BY visit_count DESC
      LIMIT ${MAX_SITES}
    `)
    // The most recent and the most visited matches are the candidates, so a broad query
    // never ranks the whole history. Those are weighted by how recent the last visit
    // was: a page used daily this week outranks one opened a hundred times last year.
    // LIKE already ignores ASCII case; the scheme is cut so "http" never matches every page.
    const matches = `(substr(url, instr(url, '://') + 3) LIKE :address ESCAPE '\\' OR title LIKE :title ESCAPE '\\')`
    this.pagesStatement = this.database.prepare(`
      WITH candidates AS (
        SELECT url FROM (SELECT url FROM browser_history WHERE ${matches} ORDER BY last_visited_at DESC LIMIT ${CANDIDATES})
        UNION
        SELECT url FROM (SELECT url FROM browser_history WHERE ${matches} ORDER BY visit_count DESC LIMIT ${CANDIDATES})
      ), grouped AS (
        SELECT url, SUM(visit_count) AS visit_count, MAX(last_visited_at) AS last_visited_at
        FROM browser_history
        WHERE url IN (SELECT url FROM candidates) AND ${matches}
        GROUP BY url
      ), ranked AS (
        SELECT * FROM grouped
        ORDER BY visit_count * CASE
            WHEN :now - last_visited_at < ${4 * DAY_MS} THEN 100
            WHEN :now - last_visited_at < ${14 * DAY_MS} THEN 70
            WHEN :now - last_visited_at < ${31 * DAY_MS} THEN 50
            WHEN :now - last_visited_at < ${90 * DAY_MS} THEN 30
            ELSE 10 END DESC,
          last_visited_at DESC
        LIMIT ${MAX_ADDRESS_PAGES}
      )
      SELECT url, visit_count, last_visited_at,
        COALESCE((
          SELECT newer.title FROM browser_history AS newer
          WHERE newer.url = ranked.url AND newer.title <> ''
          ORDER BY newer.last_visited_at DESC LIMIT 1
        ), '') AS title
      FROM ranked
    `)
    this.titleStatement = this.database.prepare(`
      SELECT title FROM browser_history WHERE url = ? AND title <> '' ORDER BY last_visited_at DESC LIMIT 1
    `)
  }

  record(url: string, title: string): void {
    const page = browserPage(url, title)
    if (page === null) return
    this.database.prepare(`
      INSERT INTO browser_history (source, url, title, visit_count, last_visited_at, origin, site)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(source, url) DO UPDATE SET
        title = CASE WHEN excluded.title = '' THEN browser_history.title ELSE excluded.title END,
        visit_count = browser_history.visit_count + 1,
        last_visited_at = excluded.last_visited_at
    `).run(MANOR_SOURCE, page.url, page.title, Date.now(), page.origin, page.site)
  }

  updateTitle(url: string, title: string): void {
    const page = browserPage(url, title)
    if (page === null || page.title === '') return
    this.database.prepare(
      'UPDATE browser_history SET title = ? WHERE source = ? AND url = ?',
    ).run(page.title, MANOR_SOURCE, page.url)
  }

  recordFavicon(url: string, favicon: string): void {
    const host = pageHost(url)
    if (host === null || !favicon.startsWith('data:image/')) return
    this.database.prepare(`
      INSERT INTO browser_favicons (host, favicon, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET favicon = excluded.favicon, updated_at = excluded.updated_at
    `).run(host, favicon, Date.now())
  }

  favicon(url: string): string | undefined {
    const host = pageHost(url)
    if (host === null) return undefined
    const row = this.faviconStatement.get(host) as { favicon: string } | undefined
    return row?.favicon
  }

  search(raw = ''): BrowserHistoryEntry[] {
    const query = raw.trim().slice(0, 500).toLowerCase()
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
    const rows = this.searchStatement.all(query, pattern, pattern, query, pattern, pattern) as Array<{
      url: string
      title: string
      visit_count: number
      last_visited_at: number
    }>
    return rows.map((row) => this.entry(row))
  }

  addressMatches(raw: string): BrowserAddressMatches {
    const query = raw.trim().slice(0, 500).toLowerCase()
    if (query === '') return { sites: [], pages: this.search() }
    const escape = (text: string) => text.replace(/[\\%_]/g, '\\$&')
    const typed = query.replace(/^[a-z][a-z\d+.-]*:\/\//, '').replace(/^www\./, '')
    const slash = typed.indexOf('/')
    // Before the host ends, any site it starts; past it, only that exact host. No host
    // has a control character, so `host + \u0001` closes a range holding host alone.
    const sites = typed === '' || /\s/.test(typed) ? []
      : slash < 0 ? this.sites(typed, typed + RANGE_END)
      : this.sites(typed.slice(0, slash), `${typed.slice(0, slash)}\u0001`)
    const rows = this.pagesStatement.all({
      address: `%${escape(typed)}%`,
      title: `%${escape(query)}%`,
      now: Date.now(),
    }) as Array<{ url: string; title: string; visit_count: number; last_visited_at: number }>
    return { sites, pages: rows.map((row) => this.entry(row)) }
  }

  private sites(from: string, until: string): BrowserHistoryEntry[] {
    const rows = this.sitesStatement.all({ from, until }) as Array<{ origin: string; visit_count: number; last_visited_at: number }>
    return rows.map((row) => {
      const root = `${row.origin}/`
      const title = this.titleStatement.get(root) as { title: string } | undefined
      return this.entry({ url: root, title: title?.title ?? '', visit_count: row.visit_count, last_visited_at: row.last_visited_at })
    })
  }

  private entry(row: { url: string; title: string; visit_count: number; last_visited_at: number }): BrowserHistoryEntry {
    const favicon = this.favicon(row.url)
    return {
      url: row.url,
      title: row.title,
      visitCount: row.visit_count,
      lastVisitedAt: row.last_visited_at,
      ...(favicon === undefined ? {} : { favicon }),
    }
  }

  /** Replaces only the imported browser's contribution; Manor's own visits survive profile refreshes. */
  replaceImported(profilePath: string): void {
    const historyPath = path.join(profilePath, 'History')
    const rows = existsSync(historyPath) ? readImportedHistory(historyPath) : []
    const insert = this.database.prepare(`
      INSERT INTO browser_history (source, url, title, visit_count, last_visited_at, origin, site)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('DELETE FROM browser_history WHERE source = ?').run(IMPORTED_SOURCE)
      for (const row of rows) {
        const { origin, site } = siteOf(row.url)
        insert.run(IMPORTED_SOURCE, row.url, row.title, row.visitCount, row.lastVisitedAt, origin, site)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  clearImported(): void {
    this.database.prepare('DELETE FROM browser_history WHERE source = ?').run(IMPORTED_SOURCE)
  }

  clearAll(): void {
    this.database.exec('DELETE FROM browser_history; DELETE FROM browser_favicons')
  }

  close(): void {
    this.database.close()
  }

  /**
   * Adds the site columns to a history file from before them and fills in any row
   * without a site, in one transaction, so an interrupted first open just runs again.
   */
  private addSiteColumns(): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const columns = new Set((this.database.prepare('PRAGMA table_info(browser_history)').all() as Array<{ name: string }>)
        .map(({ name }) => name))
      for (const column of ['origin', 'site']) {
        if (!columns.has(column)) this.database.exec(`ALTER TABLE browser_history ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`)
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS browser_history_sites
          ON browser_history(site, origin, visit_count, last_visited_at);
        CREATE INDEX IF NOT EXISTS browser_history_visits
          ON browser_history(visit_count DESC);
      `)
      const rows = this.database.prepare("SELECT DISTINCT url FROM browser_history WHERE site = ''").all() as Array<{ url: string }>
      const update = this.database.prepare('UPDATE browser_history SET origin = ?, site = ? WHERE url = ?')
      for (const { url } of rows) {
        const { origin, site } = siteOf(url)
        update.run(origin, site, url)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

function readImportedHistory(filePath: string): BrowserHistoryEntry[] {
  const database = new DatabaseSync(filePath, { readOnly: true })
  try {
    const rows = database.prepare(`
      SELECT url, COALESCE(title, '') AS title,
        MAX(1, COALESCE(visit_count, 1)) AS visit_count,
        CAST(last_visit_time AS TEXT) AS last_visit_time
      FROM urls
      WHERE hidden = 0 AND (url LIKE 'https://%' OR url LIKE 'http://%')
      ORDER BY last_visit_time DESC
      LIMIT ${MAX_IMPORTED_ENTRIES}
    `).all() as Array<{
      url: string
      title: string
      visit_count: number
      last_visit_time: string
    }>
    return rows.flatMap((row) => {
      const page = browserPage(row.url, row.title)
      const lastVisitedAt = chromiumTime(row.last_visit_time)
      if (page === null || lastVisitedAt === null) return []
      return [{
        url: page.url,
        title: page.title,
        visitCount: Math.max(1, Number(row.visit_count) || 1),
        lastVisitedAt,
      }]
    })
  } finally {
    database.close()
  }
}

function chromiumTime(raw: string): number | null {
  try {
    const timestamp = BigInt(raw) / 1_000n - CHROMIUM_TO_UNIX_EPOCH_MS
    const milliseconds = Number(timestamp)
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 8_640_000_000_000_000
      ? milliseconds
      : null
  } catch {
    return null
  }
}

function pageHost(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : null
  } catch {
    return null
  }
}

/** The scheme and host a visit was made on, and the site it counts toward. */
function siteOf(url: string): { origin: string; site: string } {
  try {
    const parsed = new URL(url)
    return { origin: `${parsed.protocol}//${parsed.host}`, site: parsed.host.replace(/^www\./, '') }
  } catch {
    return { origin: '', site: '' }
  }
}

function browserPage(url: string, title: string): { url: string; title: string; origin: string; site: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.href.length > 8_000) return null
    return { url: parsed.href, title: title.trim().slice(0, 500), ...siteOf(parsed.href) }
  } catch {
    return null
  }
}
