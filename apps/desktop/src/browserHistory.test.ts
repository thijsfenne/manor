import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserHistoryStore } from './browserHistory'

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('BrowserHistoryStore', () => {
  it('keeps Manor visits while replacing Dia history without duplicates', async () => {
    const root = await fixtureRoot()
    const store = new BrowserHistoryStore(path.join(root, 'manor-history.sqlite'))
    const first = browserImport(root, 'first', [
      ['https://dia.example/old', 'Old Dia page', 2, chromiumTime(1_700_000_000_000)],
      ['https://shared.example/', 'Dia title', 3, chromiumTime(1_710_000_000_000)],
    ])
    store.record('https://shared.example/', 'Manor title')
    store.record('https://manor.example/', 'Manor page')
    store.replaceImported(first)

    expect(store.search('shared')).toEqual([expect.objectContaining({
      url: 'https://shared.example/', title: 'Manor title', visitCount: 4,
    })])

    const second = browserImport(root, 'second', [
      ['https://dia.example/new', 'New Dia page', 7, chromiumTime(1_720_000_000_000)],
    ])
    store.replaceImported(second)
    expect(store.search('dia.example').map(({ url }) => url)).toEqual(['https://dia.example/new'])
    expect(store.search('manor.example')).toHaveLength(1)
    store.close()
  })

  it('searches titles and URLs literally and clears both sources', async () => {
    const root = await fixtureRoot()
    const store = new BrowserHistoryStore(path.join(root, 'history.sqlite'))
    store.record('https://example.com/100_percent%25', 'A Useful Page')
    store.updateTitle('https://example.com/100_percent%25', 'Updated title')

    expect(store.search('updated')[0]?.title).toBe('Updated title')
    expect(store.search('100_')).toHaveLength(1)
    expect(store.search('%')).toHaveLength(1)
    store.clearAll()
    expect(store.search()).toEqual([])
    store.close()
  })

  it('keeps a site mark per host for suggestions after its tabs close', async () => {
    const root = await fixtureRoot()
    const store = new BrowserHistoryStore(path.join(root, 'history.sqlite'))
    store.record('https://example.com/page', 'Page')
    store.recordFavicon('https://example.com/other', 'data:image/png;base64,bWFyaw==')
    store.recordFavicon('https://example.com/', 'javascript:alert(1)')

    expect(store.favicon('https://example.com/anything')).toBe('data:image/png;base64,bWFyaw==')
    expect(store.search('page')[0]?.favicon).toBe('data:image/png;base64,bWFyaw==')
    store.clearAll()
    expect(store.favicon('https://example.com/')).toBeUndefined()
    store.close()
  })

  it('revokes imported Dia history without touching Manor visits', async () => {
    const root = await fixtureRoot()
    const store = new BrowserHistoryStore(path.join(root, 'history.sqlite'))
    store.record('https://manor.example/', 'Manor')
    store.replaceImported(browserImport(root, 'dia', [
      ['https://dia.example/', 'Dia', 1, chromiumTime(1_720_000_000_000)],
    ]))
    store.clearImported()

    expect(store.search().map(({ url }) => url)).toEqual(['https://manor.example/'])
    store.close()
  })

  it('returns eight distinct recent matches and includes source rows outside the candidate window', async () => {
    const root = await fixtureRoot()
    const store = new BrowserHistoryStore(path.join(root, 'history.sqlite'))
    try {
      const base = 1_720_000_000_000
      const clock = vi.spyOn(Date, 'now')
      const rows: Array<[string, string, number, bigint]> = []
      for (let index = 0; index < 24; index += 1) {
        const url = `https://shared.example/${index}`
        clock.mockReturnValue(base + index * 10 + 1)
        store.record(url, `Current match ${index}`)
        rows.push([url, `Former match ${index}`, 3, chromiumTime(index === 23 ? base - 1 : base + index * 10)])
      }
      store.replaceImported(browserImport(root, 'dia', rows))

      const matches = store.search('match')
      expect(matches.map(({ url }) => url)).toEqual(Array.from({ length: 8 }, (_, index) => `https://shared.example/${23 - index}`))
      expect(matches.every(({ visitCount }) => visitCount === 4)).toBe(true)
      expect(matches[0]).toMatchObject({ title: 'Current match 23', lastVisitedAt: base + 231 })
      // A title match in just one source keeps the existing matching-source ordering.
      expect(store.search('former match 23')[0]).toMatchObject({ title: 'Current match 23', visitCount: 3, lastVisitedAt: base - 1 })
    } finally {
      store.close()
    }
  })

  it('keeps address suggestions within a typing-safe budget at Dia scale', async () => {
    const root = await fixtureRoot()
    const store = new BrowserHistoryStore(path.join(root, 'history.sqlite'))
    const rows: Array<[string, string, number, bigint]> = Array.from({ length: 16_517 }, (_, index) => [
      `https://history.example/page/${index}`,
      `Representative page ${index}`,
      1,
      chromiumTime(1_700_000_000_000 + index),
    ])
    store.replaceImported(browserImport(root, 'dia', rows))

    store.search('representative')
    const started = performance.now()
    for (let search = 0; search < 10; search += 1) store.search('representative')

    const averageMs = (performance.now() - started) / 10
    expect(store.search('representative').map(({ url }) => url)).toEqual(
      Array.from({ length: 8 }, (_, index) => `https://history.example/page/${16_516 - index}`),
    )
    expect(store.search('page 1234')).toHaveLength(8)
    expect(store.search('no such page')).toEqual([])
    expect(averageMs).toBeLessThan(25)
    store.close()
  })

  it('offers a host as one site at its root, ranked by the visits of all its pages', async () => {
    const root = await fixtureRoot()
    const store = new BrowserHistoryStore(path.join(root, 'history.sqlite'))
    const now = Date.now()
    store.replaceImported(browserImport(root, 'dia', [
      ['https://www.twitch.tv/zoomaa', 'Zoomaa - Twitch', 400, chromiumTime(now - 1_000)],
      ['https://www.twitch.tv/formal', 'FORMAL - Twitch', 120, chromiumTime(now - 2_000)],
      ['https://twitch.tv/', 'Twitch', 3, chromiumTime(now - 9_000)],
      ['https://twitter.com/arty_tech_', 'Profile / X', 30, chromiumTime(now - 3_000)],
      ['https://www.google.com/search?q=twitch', 'twitch - Google Search', 2, chromiumTime(now - 4_000)],
    ]))
    try {
      const { sites, pages } = store.addressMatches('twi')
      // www and bare variants fold into one site, rooted at the variant used most.
      expect(sites.map(({ url }) => url)).toEqual(['https://www.twitch.tv/', 'https://twitter.com/'])
      expect(sites[0]).toMatchObject({ visitCount: 523 })
      expect(pages.map(({ url }) => url).slice(0, 2)).toEqual(['https://www.twitch.tv/zoomaa', 'https://www.twitch.tv/formal'])
      // A scheme or `www.` never hides a page that matches without it.
      expect(store.addressMatches('https://www.twitch.tv/zo').pages.map(({ url }) => url)).toEqual(['https://www.twitch.tv/zoomaa'])
      // A scheme or a path narrows the site to that one host.
      expect(store.addressMatches('https://www.twitch.tv/zo').sites.map(({ url }) => url)).toEqual(['https://www.twitch.tv/'])
      expect(store.addressMatches('best pizza').sites).toEqual([])
      expect(store.addressMatches('witch').sites).toEqual([])
      // The scheme itself never matches every page.
      expect(store.addressMatches('https').pages).toEqual([])
    } finally {
      store.close()
    }
  })

  it('ranks a site by the visits of all its variants before taking the top few', async () => {
    const root = await fixtureRoot()
    const store = new BrowserHistoryStore(path.join(root, 'history.sqlite'))
    const now = Date.now()
    const busy: Array<[string, string, number, bigint]> = Array.from({ length: 16 }, (_, index) =>
      [`https://tw${index}.example/`, '', 200, chromiumTime(now)])
    const twitch: Array<[string, string, number, bigint]> = ([
      ['https://www.twitch.tv/', 90], ['https://twitch.tv/', 70], ['http://www.twitch.tv/', 70], ['http://twitch.tv/', 70],
    ] as const).map(([url, visits]) => [url, '', visits, chromiumTime(now)])
    store.replaceImported(browserImport(root, 'dia', [...busy, ...twitch]))
    expect(store.addressMatches('tw').sites[0]).toMatchObject({ url: 'https://www.twitch.tv/', visitCount: 300 })
    store.close()
  })

  it('answers address suggestions within a typing-safe budget at Dia scale', async () => {
    const root = await fixtureRoot()
    const store = new BrowserHistoryStore(path.join(root, 'history.sqlite'))
    const rows: Array<[string, string, number, bigint]> = Array.from({ length: 16_517 }, (_, index) => [
      `https://site${index % 700}.example/page/${index}`,
      `Representative page ${index}`,
      1 + (index % 7),
      chromiumTime(1_700_000_000_000 + index),
    ])
    store.replaceImported(browserImport(root, 'dia', rows))
    // One-letter prefixes match every row; the last two match none or almost none.
    const queries = ['s', 'si', 'site1', 'site12', 'representative', 'page/1234', 'nothing here']
    store.addressMatches('s')
    const started = performance.now()
    for (const query of queries) store.addressMatches(query)
    const averageMs = (performance.now() - started) / queries.length
    expect(store.addressMatches('site12').sites[0]?.url).toMatch(/^https:\/\/site12\d*\.example\/$/)
    expect(store.addressMatches('page/1234').pages.map(({ url }) => url)).toContain('https://site534.example/page/1234')
    expect(averageMs).toBeLessThan(25)
    store.close()
  })

  it('fills in sites for a history file written before they existed', async () => {
    const root = await fixtureRoot()
    const file = path.join(root, 'history.sqlite')
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE browser_history (
        source TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        visit_count INTEGER NOT NULL DEFAULT 1, last_visited_at INTEGER NOT NULL, PRIMARY KEY (source, url)
      );
      INSERT INTO browser_history VALUES ('manor', 'https://www.twitch.tv/zoomaa', 'Zoomaa', 9, 1);
    `)
    old.close()
    const store = new BrowserHistoryStore(file)
    expect(store.addressMatches('twitc').sites).toEqual([expect.objectContaining({ url: 'https://www.twitch.tv/', visitCount: 9 })])
    store.close()
  })

  it('finishes a first open that stopped halfway through adding the site columns', async () => {
    const root = await fixtureRoot()
    const file = path.join(root, 'history.sqlite')
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE browser_history (
        source TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        visit_count INTEGER NOT NULL DEFAULT 1, last_visited_at INTEGER NOT NULL, PRIMARY KEY (source, url)
      );
      INSERT INTO browser_history VALUES ('manor', 'https://nos.nl/artikel', 'NOS', 4, 1);
      ALTER TABLE browser_history ADD COLUMN origin TEXT NOT NULL DEFAULT '';
    `)
    old.close()
    const store = new BrowserHistoryStore(file)
    expect(store.addressMatches('nos').sites).toEqual([expect.objectContaining({ url: 'https://nos.nl/' })])
    store.close()
  })
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manor-browser-history-'))
  roots.push(root)
  return root
}

function browserImport(
  root: string,
  name: string,
  rows: Array<[url: string, title: string, visits: number, lastVisit: bigint]>,
): string {
  const profile = path.join(root, name)
  mkdirSync(profile, { recursive: true })
  const database = new DatabaseSync(path.join(profile, 'History'))
  database.exec(`
    CREATE TABLE urls (
      url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0
    )
  `)
  const insert = database.prepare('INSERT INTO urls VALUES (?, ?, ?, ?, 0)')
  database.exec('BEGIN')
  for (const row of rows) insert.run(...row)
  database.exec('COMMIT')
  database.close()
  return profile
}

function chromiumTime(unixMilliseconds: number): bigint {
  return (BigInt(unixMilliseconds) + 11_644_473_600_000n) * 1_000n
}
