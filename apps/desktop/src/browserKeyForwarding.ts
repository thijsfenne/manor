import type { BrowserWindow, Input, IpcMainEvent, WebContents } from 'electron'
import { BROWSER_SHORTCUT_CHANNEL, HOUSE_KEY_CHANNEL } from './browserChannels'
import { declinedPageKey, isCloseTabKey, routeBrowserKey } from './browserShortcuts'

/**
 * Sends keys to their owner: the Browser's own shortcuts to the panel, Manor's keys
 * typed in a focused page back to the Manor window, ⌘R outside the Browser to a reload.
 */
export function browserKeyForwarding(deps: {
  window(): BrowserWindow | null
  chromeFocused(): boolean
  /** Whether this guest (or, with none, the chrome) belongs to the Browser on screen. */
  accepts(guest?: WebContents): boolean
  /** Whether a content surface with tabs (Knowledge) holds ⌘W; see `claimCloseTab`. */
  closeTabClaimed(): boolean
}) {
  const fromKey = (event: Electron.Event, input: Input, guest?: WebContents) => {
    const window = deps.window()
    if (window === null || window.isDestroyed()) return
    const route = routeBrowserKey(input, guest !== undefined, deps.chromeFocused(), deps.accepts(guest))
    if (route === undefined && guest === undefined && deps.closeTabClaimed() && isCloseTabKey(input)) {
      // The File menu's Close Window would take ⌘W first; the surface closes a tab instead.
      event.preventDefault()
      window.webContents.send(HOUSE_KEY_CHANNEL, input.key)
      return
    }
    if (route === undefined) return
    event.preventDefault()
    if (route.to === 'manor-reload') window.webContents.reload()
    else if (route.to === 'browser') window.webContents.send(BROWSER_SHORTCUT_CHANNEL, route.shortcut)
    else window.webContents.send(HOUSE_KEY_CHANNEL, route.key)
  }
  /** A page-first key (⌘F, ⌘K…) the showing page's main frame let through. */
  const declined = (event: IpcMainEvent, key: unknown) => {
    const window = deps.window()
    if (window === null || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return
    if (!deps.accepts(event.sender)) return
    const route = declinedPageKey(key)
    if (route?.to === 'browser') window.webContents.send(BROWSER_SHORTCUT_CHANNEL, route.shortcut)
    else if (route?.to === 'manor') window.webContents.send(HOUSE_KEY_CHANNEL, route.key)
  }
  /** A page that is not an attached webview, such as a sign-in popup: its keys count only while it is on screen. */
  const watchPopup = (contents: WebContents) => {
    contents.on('before-input-event', (event, input) => { if (deps.accepts(contents)) fromKey(event, input, contents) })
  }
  return { fromKey, declined, watchPopup }
}
