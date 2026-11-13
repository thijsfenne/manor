import type { BrowserSavedPasswords, ImportBrowserId } from '@manor/contracts'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  safeStorage,
  session,
  shell,
  webContents,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron'
import { BrowserAdblock } from './browserAdblock'
import { ADBLOCK_PRELOAD_PATH, buildAdblockEngine, loadAdblockEngine } from './browserAdblockRuntime'
import { BROWSER_PREVIEW_CHANNEL, BROWSER_STATE_CHANNEL, GUEST_UNHANDLED_KEY_CHANNEL } from './browserChannels'
import { browserKeyForwarding } from './browserKeyForwarding'
import { BrowserBookmarksStore } from './browserBookmarks'
import { BrowserHistoryStore } from './browserHistory'
import { PasswordAutofill } from './browserPasswordAutofill'
import { BrowserPasswordStore } from './browserPasswords'
import { BROWSER_PROFILE_PARTITION, BrowserManager } from './browserManager'
import { guardWebviewAttachments } from './browserWebviews'
import { chromeUserAgent, externalOpenUrl } from './browserValues'
import { createFileDmTabMemory, type DmTabMemory } from './dmTabMemory'
import { BrowserProfileSnapshot, IMPORT_BROWSER_IDS, type PreparedBrowserProfile } from './browserProfileSnapshot'
import { registerComputerStopIpc } from './computerStop'
import { registerNotifyIpc } from './notify'
import { createPresenceMonitor, PRESENCE_CHANNEL } from './presence'
import { registerFileIpc } from './deliveredFiles'
import { registerFolderDialogIpc } from './folderDialog'
import { registerLocalAccessIpc } from './localAccess'
import { allowsBrowserPagePermission, allowsRendererPermission } from './permissions'
import { loadRenderer } from './rendererLoad'
import { listLocalServers } from './localServers'
import { DEFAULT_RENDERER_URL, isAllowedRendererNavigation, resolveRendererUrl } from './rendererUrl'
import { bundledServerEntry, manorAnswers, startBundledServer } from './bundledServer'
import { bindPageFullscreen, bindWindowChrome, trafficLightPositionForZoom } from './windowChrome'
import { FULLSCREEN_CHANNEL, ZOOM_CHANNEL } from './zoomChannels'

let mainWindow: BrowserWindow | null = null
/** Set once the app is quitting, so the bundled server stopping then is expected. */
let quitting = false
let browserManager: BrowserManager | null = null
let browserSession: Session | null = null
let browserImport: BrowserProfileSnapshot | null = null
let dmTabMemory: DmTabMemory | null = null
let browserHistory: BrowserHistoryStore | null = null
let browserPasswords: BrowserPasswordStore | null = null
let passwordAutofill: PasswordAutofill | null = null
let browserBookmarks: BrowserBookmarksStore | null = null
let browserAdblock: BrowserAdblock | null = null
let browserProfileError: string | null = null
let browserProfileTransition = Promise.resolve()
let browserChromeFocused = false
const BROWSER_PROFILE_UNAVAILABLE = 'MANOR_BROWSER_PROFILE_UNAVAILABLE'

// `electron .` otherwise inherits the runtime's generic identity in the macOS menu
// and Dock. The packaged bundle repeats this as productName, because Finder reads
// metadata before this process gets a chance to run.
app.setName('Manor')
app.on('before-quit', () => { quitting = true })

app.whenReady().then(async () => {
  // Only `electron .` needs this: the packaged bundle carries an icon that follows
  // the system appearance, and a Dock icon set here would pin it to the light one.
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(path.resolve(__dirname, '../assets/icon.png'))
  }
  // First, because everything below reads where the server is.
  if (!(await ensureServer())) return
  // Denies the renderer's own `Notification` too, which is why done notices go out
  // through the host bridge below rather than from the page. Clipboard writes are the
  // one grant; see `permissions.ts` for why.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(allowsRendererPermission(permission)),
  )
  installAppMenu()
  registerBrowserIpc()
  registerNotifyIpc(() => mainWindow)
  // The renderer relays this to the server so a phone push can stay quiet while the
  // Mac is in use. A reloaded renderer asks for the current value instead of waiting a beat.
  const presence = createPresenceMonitor({
    power: powerMonitor,
    report: (active) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(PRESENCE_CHANNEL, active)
    },
  })
  ipcMain.handle(PRESENCE_CHANNEL, () => presence.current())
  app.on('will-quit', () => presence.stop())
  registerFileIpc(() => mainWindow)
  registerFolderDialogIpc(() => mainWindow)
  registerLocalAccessIpc(() => mainWindow)
  registerComputerStopIpc(() => mainWindow)
  registerChromeIpc()
  browserHistory = new BrowserHistoryStore(path.join(app.getPath('userData'), 'browser-history.sqlite'))
  browserBookmarks = new BrowserBookmarksStore(path.join(app.getPath('userData'), 'browser-bookmarks.sqlite'))
  browserPasswords = new BrowserPasswordStore(path.join(app.getPath('userData'), 'browser-passwords.sqlite'), {
    encrypt: (plaintext) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Manor Safe Storage is unavailable, so passwords cannot be saved.')
      return safeStorage.encryptString(plaintext)
    },
    decrypt: (encrypted) => safeStorage.decryptString(encrypted),
  })
  passwordAutofill = new PasswordAutofill(browserPasswords, ipcMain)
  browserImport = new BrowserProfileSnapshot({ manorDataDirectory: app.getPath('userData') })
  browserAdblock = new BrowserAdblock({
    directory: path.join(app.getPath('userData'), 'browser-adblock'),
    ipcMain,
    contentsById: (id) => webContents.fromId(id),
    buildEngine: buildAdblockEngine,
    loadEngine: loadAdblockEngine,
    preloadPath: ADBLOCK_PRELOAD_PATH,
  })
  // Loads the cached lists and refreshes them behind the page; pages never wait for it.
  void browserAdblock.start()
  app.on('will-quit', () => browserAdblock?.stop())
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// A sign-in popup is its own page drawn over its tab, not an attached webview. While it
// is the page on screen, Manor's keys reach Manor from it as from the tab.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') browserKeys.watchPopup(contents)
})

/**
 * Makes sure there is a server to show. Told where one is, or finding one on the
 * usual port (a checkout, a LaunchAgent), the app is only its window. Otherwise it
 * starts the copy it carries and stops it again on quit. False when that failed and
 * the app is on its way out.
 */
async function ensureServer(): Promise<boolean> {
  // `MANOR_DESKTOP_SERVER=bundled` starts the app's own copy even beside a running
  // server, on another port: a second, separate Manor, which is also how the
  // packaged app is tested on a Mac that already runs one.
  const own = process.env.MANOR_DESKTOP_SERVER === 'bundled'
  if (!own && (process.env.MANOR_DESKTOP_URL !== undefined || await manorAnswers(DEFAULT_RENDERER_URL))) return true
  const entry = bundledServerEntry(process.resourcesPath)
  // A build without the bundle (`pnpm dev`) keeps waiting for a server somebody starts.
  if (entry === null) return true
  try {
    const server = await startBundledServer({ entry, execPath: process.execPath, resourcesPath: process.resourcesPath })
    process.env.MANOR_DESKTOP_URL = `${server.origin}/`
    app.on('will-quit', () => server.stop())
    // The server going away under a running app leaves a window that can do nothing.
    server.child.once('exit', () => { if (!quitting) app.quit() })
    return true
  } catch (error: unknown) {
    dialog.showErrorBox('Manor could not start', messageOf(error))
    app.quit()
    return false
  }
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 680,
    show: false,
    backgroundColor: 'black',
    // The traffic lights sit inside the app instead of on a title bar of their own, so
    // the window has one less horizontal band. macOS only; elsewhere the platform keeps
    // its own frame. The renderer reserves the corner they land in, keyed off
    // `manorDesktop.platform` — the same darwin rule, stated twice because a sandboxed
    // preload cannot import a shared constant.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: trafficLightPositionForZoom(1) }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      disableHtmlFullscreenWindowResize: true,
    },
  })
  mainWindow = window
  bindPageFullscreen(window)
  guardWebviewAttachments(window, () => browserManager?.webviews)
  window.webContents.on('before-input-event', (event, input) => { if (window === mainWindow) browserKeys.fromKey(event, input) })
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('before-input-event', (event, input) => { if (window === mainWindow) browserKeys.fromKey(event, input, guest) })
  })
  // Runs beside the page load instead of before it: the browser copy reads the Keychain,
  // merges databases and replays cookies, and nothing needs the browser until its IPC,
  // which waits for this transition (`readyManager`).
  browserProfileTransition = browserProfileTransition.catch(() => undefined).then(async () => {
    if (browserSession !== null) {
      attachBrowserManager(window, browserSession)
      return
    }
    try {
      const snapshot = await browserImport?.prepareEnabledSnapshot()
      await installBrowserManager(window, snapshot)
    } catch (error: unknown) {
      // Fail closed: an enabled browser copy that cannot be refreshed never falls back to
      // Manor's ordinary profile. The status bridge carries the actionable error.
      browserHistory?.clearImported()
      browserProfileError = messageOf(error)
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Websites and mailto leave through the system; any other protocol goes nowhere.
    const safe = externalOpenUrl(url)
    if (safe !== null) void shell.openExternal(safe)
    return { action: 'deny' }
  })

  const rendererUrl = resolveRendererUrl(process.env.MANOR_DESKTOP_URL)
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererNavigation(url, rendererUrl)) event.preventDefault()
  })
  bindWindowChrome(
    window,
    (zoom) => {
      if (!window.isDestroyed()) window.webContents.send(ZOOM_CHANNEL, zoom)
    },
    (fullscreen) => {
      if (!window.isDestroyed()) window.webContents.send(FULLSCREEN_CHANNEL, fullscreen)
    },
  )
  window.webContents.on('render-process-gone', () => { void browserManager?.stopPreview() })
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) void browserManager?.stopPreview()
  })
  window.once('ready-to-show', () => window.show())
  window.on('close', () => {
    const manager = browserManager
    browserManager = null
    void manager?.closeAll()
    void browserSession?.cookies.flushStore().catch(() => undefined)
  })
  window.on('closed', () => {
    mainWindow = null
    browserChromeFocused = false
  })

  await loadRenderer(window, rendererUrl)
}

/**
 * Electron's default View menu reloads Manor even when the Browser has focus.
 * Route ⌘R by focus below and leave the default reload items out of the menu.
 */
function installAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]))
}

function registerBrowserIpc(): void {
  ipcMain.on('manor:browser:shortcut-focus', (event, focused: unknown) => {
    if (event.sender === mainWindow?.webContents && typeof focused === 'boolean') browserChromeFocused = focused
  })
  // The third positional slot is the retired tab-persistence flag, kept so installed shells and newer web bundles agree on argument positions.
  ipcMain.handle('manor:browser:show', async (event, bounds: unknown, chatId: unknown, _retiredPersistFlag: unknown, presentation: unknown) => {
    if (presentation !== undefined && presentation !== 'sidebar' && presentation !== 'floating') throw new Error('Invalid browser presentation.')
    await (await readyManager(event)).show(bounds, checkedChatId(chatId), undefined, presentation)
  })
  ipcMain.handle('manor:browser:hide', async (event) => {
    browserChromeFocused = false
    await (await readyManager(event)).hide()
  })
  ipcMain.handle('manor:browser:webviews:list', async (event) => (await readyManager(event)).webviews.list())
  ipcMain.handle('manor:browser:webviews:attach', async (event, id: unknown, token: unknown, contentsId: unknown) => {
    if (typeof contentsId !== 'number' || !Number.isSafeInteger(contentsId) || contentsId <= 0) throw new Error('Invalid browser guest id.')
    await (await readyManager(event)).webviews.attach(checkedChatId(id), checkedChatId(token), contentsId)
  })
  ipcMain.handle('manor:browser:webviews:presented', async (event, id: unknown, token: unknown, revision: unknown) => {
    if (typeof revision !== 'number') throw new Error('Invalid browser layout revision.')
    ;(await readyManager(event)).webviews.presented(checkedChatId(id), checkedChatId(token), revision)
  })
  ipcMain.handle('manor:browser:close', async (event, chatId: unknown) => {
    await (await readyManager(event)).close(checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:begin-agent-use', async (event, chatId: unknown) => {
    (await readyManager(event)).beginAgentUse(checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:interrupt-agent-input', async (event, chatId: unknown) => {
    await (await readyManager(event)).interruptAgentInput(checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:end-agent-use', async (event, chatId: unknown) => {
    await (await readyManager(event)).endAgentUse(checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:start-preview', async (event, chatId: unknown, subscriptionId: unknown, mode: unknown) => {
    if (mode !== undefined && mode !== 'agent' && mode !== 'manual') throw new Error('Invalid browser preview mode.')
    await (await readyManager(event)).startPreview(checkedChatId(chatId), checkedChatId(subscriptionId), mode)
  })
  ipcMain.handle('manor:browser:stop-preview', async (event, subscriptionId: unknown) => {
    await (await readyManager(event)).stopPreview(checkedChatId(subscriptionId))
  })
  ipcMain.handle('manor:browser:navigate', async (event, url: unknown, chatId: unknown) => {
    const manager = await readyManager(event)
    if (typeof url !== 'string') throw new Error('Browser navigation needs a URL.')
    return manager.navigate(url, checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:snapshot', async (event, chatId: unknown) =>
    (await readyManager(event)).snapshot(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:click', async (event, selector: unknown, chatId: unknown) => {
    if (typeof selector !== 'string') throw new Error('Browser click needs a selector.')
    return (await readyManager(event)).click(selector, checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:type', async (event, selector: unknown, text: unknown, chatId: unknown) => {
    if (typeof selector !== 'string' || typeof text !== 'string') throw new Error('Browser type needs a selector and text.')
    return (await readyManager(event)).type(selector, text, checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:press', async (event, key: unknown, chatId: unknown) => {
    if (typeof key !== 'string') throw new Error('Browser press needs a key.')
    return (await readyManager(event)).press(key, checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:scroll', async (event, deltaX: unknown, deltaY: unknown, chatId: unknown) => {
    if (typeof deltaX !== 'number' || typeof deltaY !== 'number') throw new Error('Browser scroll needs numeric deltas.')
    return (await readyManager(event)).scroll(deltaX, deltaY, checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:screenshot', async (event, chatId: unknown) =>
    (await readyManager(event)).screenshot(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:select-page-context', async (event, chatId: unknown) =>
    (await readyManager(event)).selectPageContext(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:tabs', async (event, chatId: unknown, select: unknown) => {
    if (select !== undefined && (typeof select !== 'string' || select === '')) {
      throw new Error('Browser tab selection needs a tab id.')
    }
    return (await readyManager(event)).tabs(checkedChatId(chatId), select)
  })
  ipcMain.handle('manor:browser:new-tab', async (event, chatId: unknown, url: unknown) => {
    if (url !== undefined && typeof url !== 'string') throw new Error('Opening a browser tab needs a URL.')
    return (await readyManager(event)).newTab(checkedChatId(chatId), url)
  })
  ipcMain.handle('manor:browser:close-tab', async (event, tabId: unknown, chatId: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') throw new Error('Closing a browser tab needs a tab id.')
    return (await readyManager(event)).closeTab(tabId, checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:reopen-tab', async (event, chatId: unknown) =>
    (await readyManager(event)).reopenClosedTab(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:find', async (event, chatId: unknown, query: unknown, options: unknown) => {
    if (typeof query !== 'string') throw new Error('Find on page needs text.')
    const { forward, next } = (typeof options === 'object' && options !== null ? options : {}) as Record<string, unknown>
    return (await readyManager(event)).findInPage(checkedChatId(chatId), query, forward !== false, next === true)
  })
  ipcMain.handle('manor:browser:stop-find', async (event, chatId: unknown) =>
    (await readyManager(event)).stopFind(checkedChatId(chatId)))
  ipcMain.on(GUEST_UNHANDLED_KEY_CHANNEL, browserKeys.declined)
  ipcMain.handle('manor:browser:cancel-sign-in', async (event, tabId: unknown, chatId: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') throw new Error('Cancelling a sign-in needs a tab id.')
    return (await readyManager(event)).cancelSignIn(tabId, checkedChatId(chatId))
  })
  ipcMain.handle('manor:browser:pin-tab', async (event, tabId: unknown, chatId: unknown, pinned: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') throw new Error('Pinning a browser tab needs a tab id.')
    if (typeof pinned !== 'boolean') throw new Error('Browser tab pin state must be a boolean.')
    return (await readyManager(event)).pinTab(tabId, checkedChatId(chatId), pinned)
  })
  ipcMain.handle('manor:browser:move-tab', async (event, tabId: unknown, chatId: unknown, index: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') throw new Error('Moving a browser tab needs a tab id.')
    if (!Number.isInteger(index)) throw new Error('A browser tab moves to a whole-number position.')
    return (await readyManager(event)).moveTab(tabId, checkedChatId(chatId), index as number)
  })
  ipcMain.handle('manor:browser:back', async (event, chatId: unknown) =>
    (await readyManager(event)).goBack(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:forward', async (event, chatId: unknown) =>
    (await readyManager(event)).goForward(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:reload', async (event, chatId: unknown) =>
    (await readyManager(event)).reload(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:configure', async (event, chatId: unknown, settings: unknown) =>
    (await readyManager(event)).configure(checkedChatId(chatId), settings))
  ipcMain.handle('manor:browser:hard-reload', async (event, chatId: unknown) =>
    (await readyManager(event)).hardReload(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:open-devtools', async (event, chatId: unknown) =>
    (await readyManager(event)).openDevTools(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:open-preview-window', async (event, chatId: unknown) =>
    (await readyManager(event)).openPreviewWindow(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:clear-cookies', async (event) => (await readyManager(event)).clearCookies())
  ipcMain.handle('manor:browser:clear-cache', async (event) => (await readyManager(event)).clearCache())
  ipcMain.handle('manor:browser:set-site-adblock', async (event, chatId: unknown, blocking: unknown) => {
    if (typeof blocking !== 'boolean') throw new Error('The ad block switch must be a boolean.')
    await (await readyManager(event)).setSiteAdblock(checkedChatId(chatId), blocking)
  })
  ipcMain.handle('manor:browser:history', async (event, query: unknown) => {
    if (query !== undefined && typeof query !== 'string') throw new Error('Browser history search needs text.')
    return (await readyManager(event)).history(query)
  })
  ipcMain.handle('manor:browser:address-matches', async (event, query: unknown) => {
    if (typeof query !== 'string') throw new Error('Address suggestions need text.')
    return (await readyManager(event)).addressMatches(query)
  })
  ipcMain.handle('manor:browser:local-servers', (event) => {
    ownedWindow(event)
    // Manor's own page is never a local server to open inside Manor.
    return listLocalServers(new Set([Number(new URL(resolveRendererUrl(process.env.MANOR_DESKTOP_URL)).port)]))
  })
  ipcMain.handle('manor:browser:bookmarks', (event) => {
    ownedWindow(event)
    return ownedBrowserBookmarks().list()
  })
  ipcMain.handle('manor:browser:toggle-bookmark', (event, url: unknown, title: unknown) => {
    ownedWindow(event)
    if (typeof url !== 'string' || typeof title !== 'string') throw new Error('A bookmark needs a URL and title.')
    return ownedBrowserBookmarks().toggle(url, title)
  })
  ipcMain.handle('manor:browser:fill-password', async (event, chatId: unknown, loginId: unknown) => {
    if (typeof loginId !== 'string' || loginId === '') throw new Error('Pick a saved password to fill.')
    await (await readyManager(event)).fillPassword(checkedChatId(chatId), loginId)
  })
  ipcMain.handle('manor:browser:find-saved-login', async (event, chatId: unknown, username: unknown) => {
    if (username !== undefined && typeof username !== 'string') throw new Error('A saved login is named by its username.')
    return (await readyManager(event)).findSavedLogin(checkedChatId(chatId), username)
  })
  ipcMain.handle('manor:browser:fill-saved-login', async (event, chatId: unknown, target: unknown) => {
    const { tabId, pageId, origin, loginId } = (typeof target === 'object' && target !== null ? target : {}) as Record<string, unknown>
    if (typeof tabId !== 'string' || typeof pageId !== 'number' || typeof origin !== 'string' || typeof loginId !== 'string') {
      throw new Error('A saved login fill needs the tab, page, origin and login its card named.')
    }
    return (await readyManager(event)).fillSavedLogin(checkedChatId(chatId), { tabId, pageId, origin, loginId })
  })
  ipcMain.handle('manor:browser:find-password-field', async (event, chatId: unknown) =>
    (await readyManager(event)).findPasswordField(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:fill-secret', async (event, chatId: unknown, target: unknown) => {
    const { tabId, pageId, origin, value } = (typeof target === 'object' && target !== null ? target : {}) as Record<string, unknown>
    if (typeof tabId !== 'string' || typeof pageId !== 'number' || typeof origin !== 'string' || typeof value !== 'string') {
      throw new Error('A secret fill needs the tab, page and origin its card named.')
    }
    await (await readyManager(event)).fillSecret(checkedChatId(chatId), { tabId, pageId, origin, value })
  })
  ipcMain.handle('manor:browser:answer-password-offer', async (event, chatId: unknown, tabId: unknown, choice: unknown) => {
    if (typeof tabId !== 'string' || (choice !== 'save' && choice !== 'never' && choice !== 'dismiss')) {
      throw new Error('A password offer needs its tab and a choice.')
    }
    const manager = await readyManager(event)
    await manager.answerPasswordOffer(checkedChatId(chatId), tabId, choice)
    manager.republish()
  })
  ipcMain.handle('manor:browser:saved-passwords', (event): BrowserSavedPasswords => {
    ownedWindow(event)
    return savedPasswordList()
  })
  ipcMain.handle('manor:browser:remove-saved-passwords', (event, target: unknown): BrowserSavedPasswords => {
    ownedWindow(event)
    const passwords = ownedBrowserPasswords()
    const { loginId, neverSaveOrigin } = (typeof target === 'object' && target !== null ? target : {}) as Record<string, unknown>
    if (target === undefined) passwords.removeAll()
    else if (typeof loginId === 'string' && loginId !== '') passwords.remove(loginId)
    else if (typeof neverSaveOrigin === 'string') passwords.allowSaving(neverSaveOrigin)
    else throw new Error('Pick a saved password or site to remove.')
    browserManager?.republish()
    return savedPasswordList()
  })
  ipcMain.handle('manor:browser:stop', async (event, chatId: unknown) =>
    (await readyManager(event)).stopLoading(checkedChatId(chatId)))
  ipcMain.handle('manor:browser:clear-data', async (event) => {
    const window = ownedWindow(event)
    await browserProfileTransition.catch(() => undefined)
    if (await ownedBrowserImport().isEnabled()) await queueBrowserProfileReplacement(window, false)
    await (await readyManager(event)).clearData()
  })
  ipcMain.handle('manor:browser:import-status', async (event) => {
    ownedWindow(event)
    await browserProfileTransition.catch(() => undefined)
    return ownedBrowserImport().status()
  })
  ipcMain.handle('manor:browser:set-import', async (event, enabled: unknown, browser: unknown) => {
    const window = ownedWindow(event)
    if (typeof enabled !== 'boolean') throw new Error('Browser import consent must be a boolean.')
    const source = IMPORT_BROWSER_IDS.find((id) => id === browser)
    if (browser !== undefined && browser !== null && source === undefined) throw new Error('That browser is not one Manor can copy from.')
    await queueBrowserProfileReplacement(window, enabled, source)
    return ownedBrowserImport().status()
  })
}

function queueBrowserProfileReplacement(window: BrowserWindow, enabled: boolean, browser?: ImportBrowserId): Promise<void> {
  const transition = browserProfileTransition
    .catch(() => undefined)
    .then(() => replaceBrowserProfile(window, enabled, browser))
  browserProfileTransition = transition
  return transition
}

async function installBrowserManager(
  window: BrowserWindow,
  prepared: PreparedBrowserProfile | null | undefined,
): Promise<void> {
  const history = ownedBrowserHistory()
  importSavedPasswords(prepared)
  if (prepared === null || prepared === undefined) {
    history.clearImported()
  } else {
    try { history.replaceImported(prepared.path) }
    catch (error: unknown) {
      // History is useful but not a credential boundary. A changed source schema must
      // not turn an otherwise valid signed-in browser into a startup failure.
      history.clearImported()
      console.warn('[manor] browser history import failed', messageOf(error))
    }
  }
  const profile = prepared === null || prepared === undefined
    ? session.fromPartition(BROWSER_PROFILE_PARTITION)
    : session.fromPath(prepared.path)
  profile.setUserAgent(chromeUserAgent(profile.getUserAgent()))
  bindCookieFlush(profile)
  profile.setPermissionCheckHandler((_contents, permission) => allowsBrowserPagePermission(permission))
  profile.setPermissionRequestHandler((_contents, permission, callback) => callback(allowsBrowserPagePermission(permission)))
  browserAdblock?.attach(profile)
  if (prepared !== null && prepared !== undefined) {
    try {
      for (const cookie of prepared.cookies) {
        await profile.cookies.set(cookie)
      }
      profile.flushStorageData()
    } catch (error: unknown) {
      // A fresh copy holds only the source's state, so a half import is wiped. A kept
      // generation also holds Manor's own logins and is left for the next launch.
      if (prepared.fresh) await profile.clearData()
      throw error
    }
  }
  browserSession = profile
  attachBrowserManager(window, profile)
}

/** The source browser's saved passwords follow the toggle: imported while on, removed once off. */
function importSavedPasswords(prepared: PreparedBrowserProfile | null | undefined): void {
  try {
    if (prepared === null || prepared === undefined) ownedBrowserPasswords().clearImported()
    else ownedBrowserPasswords().replaceImported(prepared.logins, prepared.neverSaveOrigins)
  } catch (error: unknown) {
    // Like history, saved passwords help but are not what keeps a site signed in.
    console.warn('[manor] saved passwords import failed', messageOf(error))
  }
}

/**
 * Electron writes cookies to disk only every 30 seconds. A sign-in is flushed about
 * a second after it lands, so a killed or restarted app does not lose it.
 */
function bindCookieFlush(profile: Session): void {
  let pending: NodeJS.Timeout | undefined
  profile.cookies.on('changed', () => {
    if (pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      void profile.cookies.flushStore().catch(() => undefined)
    }, 1_000)
  })
}

function attachBrowserManager(window: BrowserWindow, profile: Session): void {
  browserProfileError = null
  browserManager = new BrowserManager(
    window,
    profile,
    (state) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(BROWSER_STATE_CHANNEL, state)
    },
    undefined,
    undefined,
    ownedDmTabMemory(),
    (update) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(BROWSER_PREVIEW_CHANNEL, update)
    },
    ownedBrowserHistory(),
    undefined,
    passwordAutofill ?? undefined,
    browserAdblock ?? undefined,
  )
}

async function replaceBrowserProfile(window: BrowserWindow, enabled: boolean, browser?: ImportBrowserId): Promise<void> {
  const profiles = ownedBrowserImport()
  const previousManager = browserManager
  const previousSession = browserSession
  browserManager = null
  browserSession = null
  await previousManager?.closeAll()
  previousSession?.flushStorageData()

  if (enabled) {
    let prepared: PreparedBrowserProfile
    try {
      prepared = await profiles.enable(browser)
    } catch (error: unknown) {
      // The copy could not be made. A copy that was already in use (a switch to
      // another browser that failed) is still whole and comes back; without one
      // this is the ordinary profile.
      const kept = await profiles.prepareEnabledSnapshot().catch(() => null)
      await installBrowserManager(window, kept)
      throw error
    }
    try {
      await installBrowserManager(window, prepared)
    } catch (error: unknown) {
      // A failed switch does not retain the just-copied credentials.
      try {
        await profiles.disable()
      } catch {
        throw new Error(`${messageOf(error)} Manor also could not delete the failed browser copy.`)
      }
      await installBrowserManager(window, null)
      throw error
    }
    return
  }

  try {
    await previousSession?.clearData()
    await profiles.disable()
    await installBrowserManager(window, null)
  } catch (error: unknown) {
    // Revocation is not reported as complete while credentials still exist.
    if (previousSession !== null) {
      browserSession = previousSession
      attachBrowserManager(window, previousSession)
    }
    throw error
  }
}

function registerChromeIpc(): void {
  ipcMain.handle(ZOOM_CHANNEL, (event) => {
    if (mainWindow === null || event.sender.id !== mainWindow.webContents.id) {
      throw new Error('Zoom IPC came from outside the Manor window.')
    }
    return mainWindow.webContents.getZoomFactor()
  })
  ipcMain.handle(FULLSCREEN_CHANNEL, (event) => {
    if (mainWindow === null || event.sender.id !== mainWindow.webContents.id) {
      throw new Error('Fullscreen IPC came from outside the Manor window.')
    }
    return mainWindow.isFullScreen()
  })
}

async function readyManager(event: IpcMainInvokeEvent): Promise<BrowserManager> {
  ownedWindow(event)
  await browserProfileTransition.catch(() => undefined)
  if (browserManager === null) {
    const message = browserProfileError ?? 'The Manor browser is not ready.'
    throw new Error(`${BROWSER_PROFILE_UNAVAILABLE}: ${message}`)
  }
  return browserManager
}

function ownedWindow(event: IpcMainInvokeEvent): BrowserWindow {
  if (mainWindow === null || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('Browser IPC came from outside the Manor window.')
  }
  return mainWindow
}

function ownedBrowserImport(): BrowserProfileSnapshot {
  if (browserImport === null) throw new Error('Browser profile copies are not ready.')
  return browserImport
}

function ownedDmTabMemory(): DmTabMemory {
  if (dmTabMemory === null) {
    dmTabMemory = createFileDmTabMemory(path.join(app.getPath('userData'), 'dm-browser-tabs.json'))
  }
  return dmTabMemory
}

function ownedBrowserHistory(): BrowserHistoryStore {
  if (browserHistory === null) throw new Error('Browser history is not ready.')
  return browserHistory
}

function savedPasswordList(): BrowserSavedPasswords {
  const passwords = ownedBrowserPasswords()
  return { logins: passwords.list(), neverSave: passwords.neverSaveList() }
}

function ownedBrowserPasswords(): BrowserPasswordStore {
  if (browserPasswords === null) throw new Error('Saved passwords are not ready.')
  return browserPasswords
}

function ownedBrowserBookmarks(): BrowserBookmarksStore {
  if (browserBookmarks === null) throw new Error('Browser bookmarks are not ready.')
  return browserBookmarks
}

const browserKeys = browserKeyForwarding({
  window: () => mainWindow,
  chromeFocused: () => browserChromeFocused,
  accepts: (guest) => browserManager?.acceptsShortcut(guest) ?? false,
})

function checkedChatId(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('Browser IPC received an invalid chat id.')
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
