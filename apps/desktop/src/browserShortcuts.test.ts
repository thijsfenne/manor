import { describe, expect, it } from 'vitest'
import { browserShortcut, browserShortcutTarget, declinedPageKey, routeBrowserKey } from './browserShortcuts'

const input = (key: string, changes: Partial<Parameters<typeof browserShortcut>[0]> = {}) => ({
  type: 'keyDown' as const, key, meta: true, control: false, shift: false, alt: false, isAutoRepeat: false, ...changes,
})

describe('browserShortcutTarget', () => {
  it('reloads the focused Browser and otherwise reloads Manor from its own window', () => {
    expect(browserShortcutTarget('reload', false, true, true)).toBe('browser')
    expect(browserShortcutTarget('reload', true, false, true)).toBe('browser')
    expect(browserShortcutTarget('reload', false, false, true)).toBe('manor')
    expect(browserShortcutTarget('reload', false, true, false)).toBe('manor')
    expect(browserShortcutTarget('reload', true, false, false)).toBeUndefined()
    expect(browserShortcutTarget('new-tab', false, false, true)).toBeUndefined()
  })
})

describe('browserShortcut', () => {
  it('recognizes only the agreed browser actions', () => {
    expect(['t', 'w', 'l', 'r', 'd', '[', ']'].map((key) => browserShortcut(input(key))))
      .toEqual(['new-tab', 'close-tab', 'focus-address', 'reload', 'toggle-bookmark', 'back', 'forward'])
    expect(browserShortcut(input('Tab', { meta: false, control: true }))).toBe('next-tab')
    expect(browserShortcut(input('Tab', { meta: false, control: true, shift: true }))).toBe('previous-tab')
  })

  it('leaves other key combinations to the focused page', () => {
    expect(browserShortcut(input('w', { meta: false }))).toBeUndefined()
    expect(browserShortcut(input('w', { shift: true }))).toBeUndefined()
    expect(browserShortcut(input('t', { type: 'keyUp' }))).toBeUndefined()
    expect(browserShortcut(input('l', { alt: true }))).toBeUndefined()
    expect(browserShortcut(input('d', { isAutoRepeat: true }))).toBeUndefined()
  })
})

describe('routeBrowserKey', () => {
  it('keeps Manor keys working while a web page has focus', () => {
    expect(['1', '9', 'n', ',', '.'].map((key) => routeBrowserKey(input(key), true, false, true)))
      .toEqual(['1', '9', 'n', ',', '.'].map((key) => ({ to: 'manor', key })))
    // Pages that are not showing still give Manor its keys back.
    expect(routeBrowserKey(input('1'), true, false, false)).toEqual({ to: 'manor', key: '1' })
  })

  it('leaves page-first keys and plain typing to the page', () => {
    for (const key of ['f', 'k', 'b', 's', ';', 'c', 'v', 'a']) expect(routeBrowserKey(input(key), true, false, true)).toBeUndefined()
    expect(routeBrowserKey(input('1', { meta: false }), true, false, true)).toBeUndefined()
    expect(routeBrowserKey(input('1', { alt: true }), true, false, true)).toBeUndefined()
  })

  it('sends ⌘F from the focused chrome straight to find, and nowhere while the chat has focus', () => {
    expect(routeBrowserKey(input('f'), false, true, true)).toEqual({ to: 'browser', shortcut: 'find' })
    expect(routeBrowserKey(input('f'), false, false, true)).toBeUndefined()
  })

  it('zooms and reopens tabs in the focused browser, and leaves Manor zoom to the chat', () => {
    expect(routeBrowserKey(input('=', { shift: true }), true, false, true)).toEqual({ to: 'browser', shortcut: 'zoom-in' })
    expect(routeBrowserKey(input('-'), false, true, true)).toEqual({ to: 'browser', shortcut: 'zoom-out' })
    expect(routeBrowserKey(input('0'), true, false, true)).toEqual({ to: 'browser', shortcut: 'zoom-reset' })
    expect(routeBrowserKey(input('T', { shift: true }), true, false, true)).toEqual({ to: 'browser', shortcut: 'reopen-tab' })
    expect(routeBrowserKey(input('='), false, false, true)).toBeUndefined()
  })
})

describe('declinedPageKey', () => {
  it('turns a declined ⌘F into find and the rest into Manor keys, and ignores anything else', () => {
    expect(declinedPageKey('f')).toEqual({ to: 'browser', shortcut: 'find' })
    expect(declinedPageKey('k')).toEqual({ to: 'manor', key: 'k' })
    expect(declinedPageKey('1')).toBeUndefined()
    expect(declinedPageKey({})).toBeUndefined()
  })
})
