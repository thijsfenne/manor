import { describe, expect, it } from 'vitest'
import { BrowserSearchEngineSchema, type BrowserAddressMatches, type BrowserHistoryEntry, type BrowserTabState } from '@manor/contracts'
import { carriesSecret, inlineCompletion, planAddress, shownUrl } from '../src/browserSuggestions'
import { addressSearches, resolveBrowserAddress, searchUrl } from '../src/browserAddress'

const visit = (url: string, title = '', visitCount = 1): BrowserHistoryEntry => ({ url, title, visitCount, lastVisitedAt: 1 })
// What the desktop answers for "twi": twitch.tv as one site with all its visits.
const twitch: BrowserAddressMatches = {
  sites: [visit('https://www.twitch.tv/', '(99+) Twitch', 523), visit('https://twitter.com/', '', 30)],
  pages: [
    visit('https://www.twitch.tv/zoomaa', '(99+) Zoomaa - Twitch', 400),
    visit('https://www.twitch.tv/formal', 'FORMAL - Twitch', 120),
    visit('https://twitter.com/arty_tech_', 'Profile / X', 30),
    visit('https://www.twitch.tv/auth/callback?authProvider=Google&code=4%2F0AXlqoi', 'Twitch', 50),
  ],
}

describe('inline completion', () => {
  it('completes a prefix to the most visited host at its root, never to a sub-page', () => {
    expect(inlineCompletion('twitc', twitch)).toMatchObject({ rest: 'h.tv', url: 'https://www.twitch.tv/', title: 'Twitch' })
    expect(inlineCompletion('https://www.TWI', twitch)).toMatchObject({ rest: 'tch.tv' })
    expect(inlineCompletion('twitt', twitch)).toMatchObject({ rest: 'er.com', url: 'https://twitter.com/', title: 'twitter.com' })
  })

  it('finds the host root from pages alone, as an older desktop shell sends them', () => {
    expect(inlineCompletion('twitc', { sites: [], pages: twitch.pages })).toMatchObject({ url: 'https://www.twitch.tv/' })
  })

  it('completes into a page only once the typed text reaches past the host, and never into a callback', () => {
    expect(inlineCompletion('twitch.tv/zo', twitch)).toMatchObject({ rest: 'omaa', url: 'https://www.twitch.tv/zoomaa' })
    expect(inlineCompletion('twitch.tv/', twitch)).toMatchObject({ rest: '', url: 'https://www.twitch.tv/' })
    expect(inlineCompletion('twitch.tv/au', twitch)).toBeUndefined()
    const tracked = { sites: [], pages: [visit(`https://example.com/article?tracking=${'x'.repeat(60)}`)] }
    expect(inlineCompletion('example.com/ar', tracked)).toBeUndefined()
  })

  it('never completes a search, a prefix inside a host, or an unknown prefix', () => {
    expect(inlineCompletion('twitch streams', twitch)).toBeUndefined()
    expect(inlineCompletion('witch', twitch)).toBeUndefined()
    expect(inlineCompletion('zzz', twitch)).toBeUndefined()
  })
})

describe('address rows', () => {
  it('leads with the completed site, then the search, then other sites and pages', () => {
    const { rows, completion } = planAddress('twi', twitch, 'google')
    expect(completion?.url).toBe('https://www.twitch.tv/')
    expect(rows.map((row) => row.key)).toEqual([
      'site:https://www.twitch.tv/', 'search', 'site:https://twitter.com/',
      'https://www.twitch.tv/zoomaa', 'https://www.twitch.tv/formal', 'https://twitter.com/arty_tech_',
    ])
  })

  it('drops the completion after a deletion and lets the typed text search first', () => {
    const { rows, completion } = planAddress('twi', twitch, 'google', [], false)
    expect(completion).toBeUndefined()
    expect(rows.slice(0, 2).map((row) => row.key)).toEqual(['search', 'site:https://www.twitch.tv/'])
  })

  it('offers an address as itself before the search, and plain words as a search only', () => {
    expect(planAddress('localhost:3000', { sites: [], pages: [] }, 'google').rows.map((row) => row.kind)).toEqual(['address', 'search'])
    expect(planAddress('best pizza', twitch, 'google').rows.map((row) => row.kind)).toEqual(['search'])
  })

  it('lists matching open tabs once, beside history', () => {
    const tab = { id: 't1', url: 'https://www.twitch.tv/formal', title: 'FORMAL - Twitch' } as BrowserTabState
    const keys = planAddress('formal', twitch, 'google', [tab]).rows.map((row) => row.key)
    expect(keys).toEqual(['search', 'tab:t1'])
  })

  it('never offers a tab carrying a token, and ignores a typed scheme when matching', () => {
    const tab = { id: 't2', url: 'https://app.example/done?access_token=synthetic', title: 'Done' } as BrowserTabState
    expect(planAddress('app', { sites: [], pages: [] }, 'google', [tab]).rows.map((row) => row.kind)).toEqual(['search'])
    expect(planAddress('https://www.formal', twitch, 'google').rows.map((row) => row.key)).toContain('https://www.twitch.tv/formal')
  })

  it('lists recent safe visits only for an empty field', () => {
    const { rows } = planAddress('', twitch, 'google')
    expect(rows.every((row) => row.kind === 'visit')).toBe(true)
    expect(rows).toHaveLength(3)
  })
})

describe('address text', () => {
  it('reads a domain, localhost or an IP as an address, and anything else as a search', () => {
    expect(resolveBrowserAddress('localhost:3000', 'google')).toBe('http://localhost:3000')
    expect(resolveBrowserAddress('192.168.1.1:8080/x', 'google')).toBe('http://192.168.1.1:8080/x')
    expect(resolveBrowserAddress('nos.nl', 'google')).toBe('https://nos.nl')
    expect(addressSearches('best pizza')).toBe(true)
    expect(addressSearches('twitc')).toBe(true)
    // "js" is no top-level domain, so this is something to look up.
    expect(addressSearches('node.js')).toBe(true)
  })

  it('sends words to each engine with the text encoded', () => {
    const urls = BrowserSearchEngineSchema.options.map((engine) => searchUrl(' fish & chips ', engine))
    expect(urls).toEqual([
      'https://www.google.com/search?q=fish+%26+chips',
      'https://duckduckgo.com/?q=fish+%26+chips',
      'https://www.bing.com/search?q=fish+%26+chips',
      'https://search.brave.com/search?q=fish+%26+chips',
      'https://www.ecosia.org/search?q=fish+%26+chips',
      'https://kagi.com/search?q=fish+%26+chips',
    ])
    expect(resolveBrowserAddress('fish & chips', 'kagi')).toBe('https://kagi.com/search?q=fish+%26+chips')
  })

  it('opens an address as an address whatever the engine', () => {
    for (const engine of BrowserSearchEngineSchema.options) {
      expect(resolveBrowserAddress('nos.nl', engine)).toBe('https://nos.nl')
      expect(resolveBrowserAddress('localhost:3000', engine)).toBe('http://localhost:3000')
    }
  })

  it('tells words from an address for an engine with a path and for the one without', () => {
    expect(addressSearches('best pizza')).toBe(true)
    expect(addressSearches('nos.nl')).toBe(false)
    expect(addressSearches('')).toBe(false)
    // A pasted results page is an address to open, not words to search again.
    expect(addressSearches('https://duckduckgo.com/?q=pizza')).toBe(false)
    for (const engine of ['google', 'duckduckgo'] as const) {
      expect(planAddress('best pizza', twitch, engine).rows.map((row) => row.kind)).toEqual(['search'])
      expect(planAddress('localhost:3000', { sites: [], pages: [] }, engine).rows.map((row) => row.kind)).toEqual(['address', 'search'])
    }
  })

  it('hides long query tails and refuses addresses carrying codes', () => {
    expect(shownUrl('https://www.twitch.tv/')).toBe('twitch.tv')
    expect(shownUrl('https://example.com/a?b=1')).toBe('example.com/a?b=1')
    expect(shownUrl(`https://example.com/a?ref=${'x'.repeat(60)}`)).toBe('example.com/a')
    expect(carriesSecret('https://app.example/done?access_token=abc')).toBe(true)
    expect(carriesSecret('https://app.example/oauth/callback')).toBe(true)
    expect(carriesSecret('https://app.example/#/done?access_token=abc')).toBe(true)
    expect(carriesSecret('https://me:pass@app.example/')).toBe(true)
    expect(carriesSecret('https://example.com/search?q=pizza')).toBe(false)
  })
})
