import { describe, expect, it, vi } from 'vitest'

const writeText = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ clipboard: { writeText }, Menu: {} }))

import { contextMenuTemplate } from './browserContextMenu'

const params = {
  linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false,
  misspelledWord: '', dictionarySuggestions: [], x: 10, y: 20,
  editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
} as const

const contents = {
  navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
  reload: vi.fn(),
}

const labels = (items: ReturnType<typeof contextMenuTemplate>) => items.map((item) => item.label ?? item.type)

describe('browser context menu', () => {
  it('offers navigation on plain page space', () => {
    const items = contextMenuTemplate({ ...params } as never, contents as never, vi.fn())
    expect(labels(items)).toEqual(['Back', 'Forward', 'Reload', 'separator', 'Inspect element'])
    expect(items[1]?.enabled).toBe(false)
  })

  it('opens a link as a background tab and copies its address', () => {
    const openLink = vi.fn()
    const items = contextMenuTemplate({ ...params, linkURL: 'https://x.com/post/1' } as never, contents as never, openLink)
    expect(labels(items)).toEqual(['Open link in new tab', 'Copy link address', 'separator', 'Inspect element'])
    items[0]?.click?.({} as never, undefined, {} as never)
    items[1]?.click?.({} as never, undefined, {} as never)
    expect(openLink).toHaveBeenCalledWith('https://x.com/post/1')
    expect(writeText).toHaveBeenCalledWith('https://x.com/post/1')
  })

  it('gives an editable field its edit actions instead of navigation', () => {
    const items = contextMenuTemplate({ ...params, isEditable: true } as never, contents as never, vi.fn())
    expect(labels(items)).toEqual(['Cut', 'Copy', 'Paste', 'Select all', 'separator', 'Inspect element'])
    expect(items.slice(0, 4).map((item) => item.enabled)).toEqual([false, false, true, true])
  })
})
