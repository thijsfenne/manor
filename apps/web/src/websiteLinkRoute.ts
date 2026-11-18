import { BROWSER_HOME_SESSION_ID, type Chat, type DesktopBrowserBridge } from '@manor/contracts'
import { isWebsiteUrl } from './components/ExternalLink'
import { openWebsiteInBrowser } from './desktopBrowser'

/**
 * Whether a chat's rail offers its own Browser panel. The Browser place, a pair chat and
 * a Session its project thread started have none, see `chatRailItems`.
 */
export const hasOwnBrowserPanel = (chat: Pick<Chat, 'kind'>, roomSession: boolean): boolean =>
  chat.kind !== 'browser' && chat.kind !== 'pair' && !roomSession

/**
 * Route a clicked website to a Browser the user will see: the chat's own Browser panel,
 * or else a new tab of the full Browser, which the click switches to. Without the
 * desktop Browser the link is not claimed, so the anchor opens the system browser.
 */
export function routeWebsiteLink(url: string, {
  browser,
  chat,
  roomSession,
  phone,
  showPanel,
  showFullBrowser,
  onFailure,
}: {
  browser: Pick<DesktopBrowserBridge, 'newTab' | 'navigate'> | undefined
  chat: Pick<Chat, 'id' | 'kind'> | undefined
  /** Whether the chat is a Session its project thread started. */
  roomSession: boolean
  phone: boolean
  showPanel: (chatId: string) => void
  showFullBrowser: () => void
  onFailure: (url: string) => void
}): boolean {
  if (browser === undefined || phone || chat === undefined || !isWebsiteUrl(url)) return false
  const ownPanel = hasOwnBrowserPanel(chat, roomSession)
  if (ownPanel) showPanel(chat.id)
  else showFullBrowser()
  void openWebsiteInBrowser(browser, ownPanel ? chat.id : BROWSER_HOME_SESSION_ID, url)
    .catch(() => onFailure(url))
  return true
}
