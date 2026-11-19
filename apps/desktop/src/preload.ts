import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BrowserSessionState,
  BrowserWebviewSnapshot,
  BrowserPreviewUpdate,
  BrowserShortcut,
  DesktopBrowserBridge,
  DesktopComputerBridge,
  DesktopDoneNotice,
  DesktopFilesBridge,
  DesktopHostBridge,
  DesktopNotifyBridge,
  DesktopPermissionsBridge,
  DesktopPresenceBridge,
} from '@manor/contracts'

/**
 * Written out rather than imported, and it has to stay that way. This file runs as a
 * sandboxed preload, where `require` resolves `electron` and a handful of Node
 * built-ins and nothing else: one import of a sibling module throws before
 * `exposeInMainWorld` runs, `window.manorDesktop` is simply absent, and Manor
 * concludes there is no desktop host and hides the browser entirely. Type imports
 * are erased and therefore fine; a runtime one is not. `browserChannels.ts`,
 * `notifyChannels.ts`, `folderDialog.ts`, `localAccess.ts` and `systemPermissions.ts` hold the same strings for the main process, and
 * `smoke:preload` fails if they disagree.
 */
const BROWSER_STATE_CHANNEL = 'manor:browser:state'
const BROWSER_PREVIEW_CHANNEL = 'manor:browser:preview'
const BROWSER_SHORTCUT_CHANNEL = 'manor:browser:shortcut'
const HOUSE_KEY_CHANNEL = 'manor:house-key'
const NOTIFY_ACTIVATE_CHANNEL = 'manor:notify:activate'
const PRESENCE_CHANNEL = 'manor:presence'
const ZOOM_CHANNEL = 'manor:zoom'
const FULLSCREEN_CHANNEL = 'manor:fullscreen'
const CHOOSE_FOLDER_CHANNEL = 'manor:choose-folder'
const LOCAL_ACCESS_CHANNEL = 'manor:local-access'
const PERMISSIONS_STATUS_CHANNEL = 'manor:permissions:status'
const PERMISSIONS_OPEN_CHANNEL = 'manor:permissions:open'

// A Manor shortcut typed while a web page had focus never reached this window; main
// sends it here and it is replayed where Manor's own key listeners wait.
ipcRenderer.on(HOUSE_KEY_CHANNEL, (_event, key: unknown) => {
  if (typeof key !== 'string' || key.length !== 1) return
  window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }))
})

const browser: DesktopBrowserBridge = {
  show: (bounds, chatId, retiredPersistFlag, presentation) => ipcRenderer.invoke('manor:browser:show', bounds, chatId, retiredPersistFlag, presentation),
  webviews: {
    list: () => ipcRenderer.invoke('manor:browser:webviews:list'),
    attach: (id, token, contentsId) => ipcRenderer.invoke('manor:browser:webviews:attach', id, token, contentsId),
    presented: (id, token, revision) => ipcRenderer.invoke('manor:browser:webviews:presented', id, token, revision),
    onChange: (listener) => {
      const handler = (_event: IpcRendererEvent, snapshot: BrowserWebviewSnapshot) => listener(snapshot)
      ipcRenderer.on('manor:browser:webviews', handler)
      return () => ipcRenderer.off('manor:browser:webviews', handler)
    },
  },
  hide: () => ipcRenderer.invoke('manor:browser:hide'),
  close: (chatId) => ipcRenderer.invoke('manor:browser:close', chatId),
  beginAgentUse: (chatId) => ipcRenderer.invoke('manor:browser:begin-agent-use', chatId),
  endAgentUse: (chatId) => ipcRenderer.invoke('manor:browser:end-agent-use', chatId),
  interruptAgentInput: (chatId) => ipcRenderer.invoke('manor:browser:interrupt-agent-input', chatId),
  startPreview: (chatId, subscriptionId, mode) => ipcRenderer.invoke('manor:browser:start-preview', chatId, subscriptionId, mode),
  stopPreview: (subscriptionId) => ipcRenderer.invoke('manor:browser:stop-preview', subscriptionId),
  onPreview: (listener) => {
    const handler = (_event: IpcRendererEvent, update: BrowserPreviewUpdate) => listener(update)
    ipcRenderer.on(BROWSER_PREVIEW_CHANNEL, handler)
    return () => ipcRenderer.off(BROWSER_PREVIEW_CHANNEL, handler)
  },
  navigate: (url, chatId) => ipcRenderer.invoke('manor:browser:navigate', url, chatId),
  snapshot: (chatId) => ipcRenderer.invoke('manor:browser:snapshot', chatId),
  click: (selector, chatId) => ipcRenderer.invoke('manor:browser:click', selector, chatId),
  type: (selector, text, chatId) => ipcRenderer.invoke('manor:browser:type', selector, text, chatId),
  press: (key, chatId) => ipcRenderer.invoke('manor:browser:press', key, chatId),
  scroll: (deltaX, deltaY, chatId) => ipcRenderer.invoke('manor:browser:scroll', deltaX, deltaY, chatId),
  screenshot: (chatId) => ipcRenderer.invoke('manor:browser:screenshot', chatId),
  selectPageContext: (chatId) => ipcRenderer.invoke('manor:browser:select-page-context', chatId),
  tabs: (chatId, select) => ipcRenderer.invoke('manor:browser:tabs', chatId, select),
  newTab: (chatId, url) => ipcRenderer.invoke('manor:browser:new-tab', chatId, url),
  closeTab: (tabId, chatId) => ipcRenderer.invoke('manor:browser:close-tab', tabId, chatId),
  cancelSignIn: (tabId, chatId) => ipcRenderer.invoke('manor:browser:cancel-sign-in', tabId, chatId),
  pinTab: (tabId, chatId, pinned) => ipcRenderer.invoke('manor:browser:pin-tab', tabId, chatId, pinned),
  moveTab: (tabId, chatId, index) => ipcRenderer.invoke('manor:browser:move-tab', tabId, chatId, index),
  goBack: (chatId) => ipcRenderer.invoke('manor:browser:back', chatId),
  goForward: (chatId) => ipcRenderer.invoke('manor:browser:forward', chatId),
  reload: (chatId) => ipcRenderer.invoke('manor:browser:reload', chatId),
  configure: (chatId, settings) => ipcRenderer.invoke('manor:browser:configure', chatId, settings),
  hardReload: (chatId) => ipcRenderer.invoke('manor:browser:hard-reload', chatId),
  openDevTools: (chatId) => ipcRenderer.invoke('manor:browser:open-devtools', chatId),
  openPreviewWindow: (chatId) => ipcRenderer.invoke('manor:browser:open-preview-window', chatId),
  clearCookies: () => ipcRenderer.invoke('manor:browser:clear-cookies'),
  clearCache: () => ipcRenderer.invoke('manor:browser:clear-cache'),
  setSiteAdblock: (chatId, blocking) => ipcRenderer.invoke('manor:browser:set-site-adblock', chatId, blocking),
  history: (query) => ipcRenderer.invoke('manor:browser:history', query),
  addressMatches: (query) => ipcRenderer.invoke('manor:browser:address-matches', query),
  bookmarks: () => ipcRenderer.invoke('manor:browser:bookmarks'),
  localServers: () => ipcRenderer.invoke('manor:browser:local-servers'),
  toggleBookmark: (url, title) => ipcRenderer.invoke('manor:browser:toggle-bookmark', url, title),
  fillPassword: (chatId, loginId) => ipcRenderer.invoke('manor:browser:fill-password', chatId, loginId),
  answerPasswordOffer: (chatId, tabId, choice) => ipcRenderer.invoke('manor:browser:answer-password-offer', chatId, tabId, choice),
  findSavedLogin: (chatId, username) => ipcRenderer.invoke('manor:browser:find-saved-login', chatId, username),
  fillSavedLogin: (chatId, target) => ipcRenderer.invoke('manor:browser:fill-saved-login', chatId, target),
  findPasswordField: (chatId) => ipcRenderer.invoke('manor:browser:find-password-field', chatId),
  fillSecret: (chatId, target) => ipcRenderer.invoke('manor:browser:fill-secret', chatId, target),
  savedPasswords: () => ipcRenderer.invoke('manor:browser:saved-passwords'),
  removeSavedPasswords: (target) => ipcRenderer.invoke('manor:browser:remove-saved-passwords', target),
  onShortcut: (listener) => {
    const handler = (_event: IpcRendererEvent, shortcut: BrowserShortcut) => listener(shortcut)
    ipcRenderer.on(BROWSER_SHORTCUT_CHANNEL, handler)
    return () => ipcRenderer.off(BROWSER_SHORTCUT_CHANNEL, handler)
  },
  setShortcutFocus: (focused) => ipcRenderer.send('manor:browser:shortcut-focus', focused),
  findInPage: (chatId, query, options) => ipcRenderer.invoke('manor:browser:find', chatId, query, options),
  stopFind: (chatId) => ipcRenderer.invoke('manor:browser:stop-find', chatId),
  reopenClosedTab: (chatId) => ipcRenderer.invoke('manor:browser:reopen-tab', chatId),
  stopLoading: (chatId) => ipcRenderer.invoke('manor:browser:stop', chatId),
  clearData: () => ipcRenderer.invoke('manor:browser:clear-data'),
  browserImportStatus: () => ipcRenderer.invoke('manor:browser:import-status'),
  setBrowserImport: (enabled, browser) => ipcRenderer.invoke('manor:browser:set-import', enabled, browser),
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: BrowserSessionState) => listener(state)
    ipcRenderer.on(BROWSER_STATE_CHANNEL, handler)
    // Returns its own undo, so a remounting panel cannot leave a listener behind.
    return () => ipcRenderer.off(BROWSER_STATE_CHANNEL, handler)
  },
}

const notify: DesktopNotifyBridge = {
  show: (notice: DesktopDoneNotice) => ipcRenderer.invoke('manor:notify:show', notice),
  badge: (count) => ipcRenderer.invoke('manor:notify:badge', count),
  onActivate: (listener) => {
    const handler = (_event: IpcRendererEvent, chatId: string) => listener(chatId)
    ipcRenderer.on(NOTIFY_ACTIVATE_CHANNEL, handler)
    return () => ipcRenderer.off(NOTIFY_ACTIVATE_CHANNEL, handler)
  },
}

const presence: DesktopPresenceBridge = {
  onChange: (listener) => {
    const handler = (_event: IpcRendererEvent, active: boolean) => listener(active)
    ipcRenderer.on(PRESENCE_CHANNEL, handler)
    void ipcRenderer.invoke(PRESENCE_CHANNEL).then(listener, () => undefined)
    return () => ipcRenderer.off(PRESENCE_CHANNEL, handler)
  },
}

const computer: DesktopComputerBridge = {
  setStopArmed: (armed, stop) => ipcRenderer.invoke('manor:computer:stop-armed', armed, stop),
  connectionLost: () => ipcRenderer.invoke('manor:computer:connection-lost'),
}

const permissions: DesktopPermissionsBridge = {
  status: () => ipcRenderer.invoke(PERMISSIONS_STATUS_CHANNEL),
  open: (id) => ipcRenderer.invoke(PERMISSIONS_OPEN_CHANNEL, id),
}

const files: DesktopFilesBridge = {
  open: (src, name) => ipcRenderer.invoke('manor:files:open', src, name),
  save: (src, name) => ipcRenderer.invoke('manor:files:save', src, name),
}

const onZoomFactor = (listener: (zoom: number) => void) => {
  const handler = (_event: IpcRendererEvent, zoom: number) => listener(zoom)
  ipcRenderer.on(ZOOM_CHANNEL, handler)
  void ipcRenderer.invoke(ZOOM_CHANNEL).then(listener, () => undefined)
  return () => ipcRenderer.off(ZOOM_CHANNEL, handler)
}

const onFullscreen = (listener: (fullscreen: boolean) => void) => {
  const handler = (_event: IpcRendererEvent, fullscreen: boolean) => listener(fullscreen)
  ipcRenderer.on(FULLSCREEN_CHANNEL, handler)
  void ipcRenderer.invoke(FULLSCREEN_CHANNEL).then(listener, () => undefined)
  return () => ipcRenderer.off(FULLSCREEN_CHANNEL, handler)
}

// `platform` rather than a "title bar is inset" flag: the preload cannot see what
// `createWindow` decided, so it hands over the fact and the renderer applies the same
// darwin rule main.ts does. `onZoomFactor` is how the page keeps the icon X in
// window points while the native lights only move on Y. `onFullscreen` lets the top bar
// drop the lights' corner: native fullscreen hides them, and a reserved corner would be a hole.
const host: DesktopHostBridge = {
  browser,
  notify,
  presence,
  computer,
  permissions,
  files,
  chooseFolder: () => ipcRenderer.invoke(CHOOSE_FOLDER_CHANNEL),
  localAccess: () => ipcRenderer.invoke(LOCAL_ACCESS_CHANNEL),
  platform: process.platform,
  onZoomFactor,
  onFullscreen,
  claimCloseTab: (claim) => ipcRenderer.send('manor:close-tab-claim', claim),
}
contextBridge.exposeInMainWorld('manorDesktop', host)
