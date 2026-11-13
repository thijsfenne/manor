import { BROWSER_HOME_SESSION_ID, type Chat, type DesktopBrowserBridge } from '@manor/contracts'
import { isWebsiteUrl } from './components/ExternalLink'
import { openWebsiteInBrowser } from './desktopBrowser'

/** Route a clicked website through the Browser owned by its chat. */
export function routeWebsiteLink(url: string, {
  browser,
  chat,
  phone,
  showPanel,
  onFailure,
}: {
  browser: Pick<DesktopBrowserBridge, 'newTab' | 'navigate'> | undefined
  chat: Pick<Chat, 'id' | 'kind'> | undefined
  phone: boolean
  showPanel: (chatId: string) => void
  onFailure: (url: string) => void
}): boolean {
  if (browser === undefined || phone || chat === undefined || chat.kind === 'pair' || !isWebsiteUrl(url)) return false
  if (chat.kind !== 'browser') showPanel(chat.id)
  const targetId = chat.kind === 'browser' ? BROWSER_HOME_SESSION_ID : chat.id
  void openWebsiteInBrowser(browser, targetId, url)
    .catch(() => onFailure(url))
  return true
}
