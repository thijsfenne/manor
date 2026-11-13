import type { Input } from 'electron'
import type { BrowserShortcut } from '@manor/contracts'

type KeyInput = Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'shift' | 'alt' | 'isAutoRepeat'>

/** The page may claim these first (⌘F in Sheets, ⌘K in Slack); the guest preload reports them when it does not. */
export const PAGE_FIRST_KEYS = ['f', 'k', 'b', 's', ';'] as const

/** Browser keys, claimed by whichever browser is showing; the caller checks which page that is. */
export function browserShortcut(input: KeyInput): BrowserShortcut | undefined {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt) return undefined
  if (input.control && !input.meta && input.key === 'Tab') {
    return input.shift ? 'previous-tab' : 'next-tab'
  }
  if (!input.meta || input.control) return undefined
  const key = input.key.toLowerCase()
  // ⌘+ is ⌘⇧= on most layouts, so zoom ignores Shift.
  if (key === '=' || key === '+') return 'zoom-in'
  if (key === '-' || key === '_') return 'zoom-out'
  if (input.shift) return key === 't' ? 'reopen-tab' : undefined
  switch (key) {
    case '0': return 'zoom-reset'
    case 't': return 'new-tab'
    case 'w': return 'close-tab'
    case 'l': return 'focus-address'
    case 'r': return 'reload'
    case 'd': return 'toggle-bookmark'
    case 'f': return 'find'
    case '[': return 'back'
    case ']': return 'forward'
    default: return undefined
  }
}

/**
 * A Manor key typed while a web page has focus. Reserved keys belong to Manor wherever
 * focus is, the way Chrome keeps ⌘1–⌘9 and ⌘N from pages; page-first keys reach Manor
 * only when the page leaves them alone.
 */
export function isReservedHouseKey(input: KeyInput): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt || input.control || input.shift || !input.meta) return false
  const key = input.key.toLowerCase()
  return (key >= '1' && key <= '9' && key.length === 1) || key === 'n' || key === ',' || key === '.'
}

/**
 * Where a key typed in the Manor window or a browser guest goes. Browser keys win while
 * the browser has focus; a page keeps page-first keys (⌘F included) until it declines them.
 */
export function routeBrowserKey(
  input: KeyInput,
  fromGuest: boolean,
  browserChromeFocused: boolean,
  browserAcceptsShortcut: boolean,
): { to: 'browser'; shortcut: BrowserShortcut } | { to: 'manor-reload' } | { to: 'manor'; key: string } | undefined {
  const shortcut = browserShortcut(input)
  if (shortcut !== undefined && !(fromGuest && shortcut === 'find')) {
    const target = browserShortcutTarget(shortcut, fromGuest, browserChromeFocused, browserAcceptsShortcut)
    if (target === 'browser') return { to: 'browser', shortcut }
    if (target === 'manor') return { to: 'manor-reload' }
  }
  if (fromGuest && isReservedHouseKey(input)) return { to: 'manor', key: input.key }
  return undefined
}

/** What a page-first key the page declined does: ⌘F finds in the page, the rest are Manor's. */
export function declinedPageKey(key: unknown): { to: 'browser'; shortcut: BrowserShortcut } | { to: 'manor'; key: string } | undefined {
  if (typeof key !== 'string' || !(PAGE_FIRST_KEYS as readonly string[]).includes(key.toLowerCase())) return undefined
  return key.toLowerCase() === 'f' ? { to: 'browser', shortcut: 'find' } : { to: 'manor', key }
}

export function browserShortcutTarget(
  shortcut: BrowserShortcut,
  fromGuest: boolean,
  browserChromeFocused: boolean,
  browserAcceptsShortcut: boolean,
): 'browser' | 'manor' | undefined {
  if (browserAcceptsShortcut && (fromGuest || browserChromeFocused)) return 'browser'
  if (!fromGuest && shortcut === 'reload') return 'manor'
  return undefined
}
