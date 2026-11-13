import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { BrowserBookmark } from '@manor/contracts'
import { normalizeWebsiteUrl } from './browserValues'

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')

/** Bookmarks belong to Manor, independently of history and the copied browser profile. */
export class BrowserBookmarksStore {
  private readonly database: InstanceType<typeof DatabaseSync>

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true })
    this.database = new DatabaseSync(filePath)
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS browser_bookmarks (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        added_at INTEGER NOT NULL
      )
    `)
  }

  list(): BrowserBookmark[] {
    return this.database.prepare('SELECT url, title, added_at FROM browser_bookmarks ORDER BY added_at DESC, url')
      .all().map((row) => ({
        url: String(row.url),
        title: String(row.title),
        addedAt: Number(row.added_at),
      }))
  }

  toggle(rawUrl: string, title: string): BrowserBookmark[] {
    // The star can only save the page's complete address, never address-bar input.
    if (!/^https?:\/\//i.test(rawUrl)) throw new Error('Only HTTP and HTTPS pages can be bookmarked.')
    const url = normalizeWebsiteUrl(rawUrl)
    if (this.database.prepare('SELECT 1 FROM browser_bookmarks WHERE url = ?').get(url)) {
      this.database.prepare('DELETE FROM browser_bookmarks WHERE url = ?').run(url)
    } else {
      this.database.prepare('INSERT INTO browser_bookmarks (url, title, added_at) VALUES (?, ?, ?)')
        .run(url, title.trim().slice(0, 500) || url, Date.now())
    }
    return this.list()
  }

  close(): void { this.database.close() }
}
