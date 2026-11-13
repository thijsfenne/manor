import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserBookmarksStore } from './browserBookmarks'

describe('BrowserBookmarksStore', () => {
  it('keeps a flat list over restart and removes the same page by URL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manor-bookmarks-'))
    const file = path.join(root, 'bookmarks.sqlite')
    try {
      const first = new BrowserBookmarksStore(file)
      expect(first.toggle('https://example.com/page', 'Example')).toEqual([
        { url: 'https://example.com/page', title: 'Example', addedAt: expect.any(Number) },
      ])
      first.close()

      const reopened = new BrowserBookmarksStore(file)
      expect(reopened.list()).toHaveLength(1)
      expect(reopened.toggle('https://example.com/page', 'Renamed')).toEqual([])
      reopened.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects blank and non-web pages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manor-bookmarks-'))
    const store = new BrowserBookmarksStore(path.join(root, 'bookmarks.sqlite'))
    try {
      expect(() => store.toggle('about:blank', 'Blank')).toThrow()
      expect(() => store.toggle('', '')).toThrow()
      expect(store.list()).toEqual([])
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
