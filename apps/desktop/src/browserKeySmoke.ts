import { createServer } from 'node:http'
import { app, ipcMain, session, webContents } from 'electron'
import { GUEST_UNHANDLED_KEY_CHANNEL } from './browserChannels'
import { BrowserHost } from './browserHost'
import { browserKeyForwarding } from './browserKeyForwarding'
import { browserSmokeWindow, mountSmokeWebviews } from './browserSmokeWindow'
import { BrowserWebviews } from './browserWebviews'

/** A page that claims ⌘B for itself, as an editor does, and has text to find. */
const PAGE = `<!doctype html><title>Keys</title>
<p>Apples and pears. More apples. Apples again.</p><input id="field" autofocus>
<button id="signin" style="position:fixed;top:0;left:0;width:200px;height:120px" onclick="open('/popup', 'signin', 'popup,width=400,height=400')">Sign in</button>
<script>addEventListener('keydown', (event) => { if (event.metaKey && event.key === 'b') event.preventDefault() })</script>`

type Heard = { keys: string[]; shortcuts: string[] }

app.whenReady().then(async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not reserve the smoke port.')
  const origin = `http://127.0.0.1:${address.port}`

  const window = browserSmokeWindow()
  const profile = session.fromPartition('manor-browserKeySmoke')
  const registry = new BrowserWebviews(window, profile)
  await mountSmokeWebviews(window, registry)
  const browser = new BrowserHost(window, profile, () => {}, registry)
  const keys = browserKeyForwarding({
    window: () => window,
    chromeFocused: () => false,
    accepts: (guest) => guest === undefined || guest === browser.activeWebContents(),
  })
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('before-input-event', (event, input) => keys.fromKey(event, input, guest))
  })
  app.on('web-contents-created', (_event, contents) => { if (contents.getType() !== 'webview') keys.watchPopup(contents) })
  ipcMain.on(GUEST_UNHANDLED_KEY_CHANNEL, keys.declined)
  const page = () => {
    const contents = browser.activeWebContents()
    if (contents === undefined) throw new Error('The smoke browser has no page.')
    return contents
  }
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  try {
    await browser.setVisible(true)
    await browser.setBounds({ x: 0, y: 0, width: 800, height: 600 })
    await browser.navigate(`${origin}/fruit`)
    window.show()
    await window.webContents.executeJavaScript(`(() => {
      globalThis.__keys = []
      globalThis.__shortcuts = []
      addEventListener('keydown', (event) => { if (event.metaKey) __keys.push(event.key) })
      manorDesktop.browser.onShortcut((shortcut) => __shortcuts.push(shortcut))
    })()`)
    page().focus()
    await page().executeJavaScript(`document.querySelector('#field').focus()`)
    for (const key of ['1', 'k', 'b', 'f', 'c']) {
      page().sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['meta'] })
      page().sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['meta'] })
      await pause(150)
    }
    const heard = await window.webContents.executeJavaScript(`({ keys: __keys, shortcuts: __shortcuts })`) as Heard
    if (!heard.keys.includes('1')) throw new Error(`⌘1 from a focused page did not reach Manor: ${JSON.stringify(heard)}`)
    if (!heard.keys.includes('k')) throw new Error(`⌘K the page left alone did not reach Manor: ${JSON.stringify(heard)}`)
    if (heard.keys.includes('b')) throw new Error('⌘B the page claimed still reached Manor.')
    if (heard.keys.includes('c')) throw new Error('⌘C left the page.')
    if (!heard.shortcuts.includes('find')) throw new Error(`⌘F the page left alone did not open find: ${JSON.stringify(heard)}`)

    // A page can dispatch its own KeyboardEvent; only typed keys may reach Manor.
    await window.webContents.executeJavaScript(`__keys = []; __shortcuts = []`)
    await page().executeJavaScript(`for (const key of ['k', 'f']) dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }))`)
    await pause(200)
    const forged = await window.webContents.executeJavaScript(`({ keys: __keys, shortcuts: __shortcuts })`) as Heard
    if (forged.keys.length > 0 || forged.shortcuts.length > 0) throw new Error(`A page-made key reached Manor: ${JSON.stringify(forged)}`)

    const first = await browser.find('apples', true, false)
    const second = await browser.find('apples', true, true)
    if (first.matches !== 3 || second.active === first.active) throw new Error(`Find did not count or step: ${JSON.stringify({ first, second })}`)
    browser.stopFind()

    const closing = browser.state().activeTabId
    await browser.newTab()
    if (closing === null) throw new Error('No tab to close.')
    await browser.closeTab(closing)
    await browser.reopenClosedTab()
    const reopened = browser.state().tabs.find((tab) => tab.id === browser.state().activeTabId)
    if (reopened?.url !== `${origin}/fruit`) throw new Error(`Reopen did not bring the page back: ${reopened?.url}`)

    // A sign-in popup drawn over the tab is the page on screen: its keys and find belong to it.
    await browser.click('#signin')
    let popup: Electron.WebContents | undefined
    for (let tries = 0; popup === undefined && tries < 40; tries += 1) {
      await pause(50)
      popup = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/popup') && contents.getTitle() === 'Keys')
    }
    if (popup === undefined) throw new Error('The sign-in popup did not open.')
    if (browser.activeWebContents() !== popup) throw new Error('The open sign-in popup is not the page on screen.')
    await window.webContents.executeJavaScript(`__keys = []; __shortcuts = []`)
    popup.focus()
    for (const key of ['1', 'f', 'k']) {
      popup.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['meta'] })
      popup.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['meta'] })
      await pause(150)
    }
    const fromPopup = await window.webContents.executeJavaScript(`({ keys: __keys, shortcuts: __shortcuts })`) as Heard
    if (!fromPopup.keys.includes('1') || !fromPopup.keys.includes('k') || !fromPopup.shortcuts.includes('find')) {
      throw new Error(`Keys typed in the sign-in popup did not reach Manor: ${JSON.stringify(fromPopup)}`)
    }
    const inPopup = await browser.find('apples', true, false)
    if (inPopup.matches !== 3) throw new Error(`Find did not search the sign-in popup: ${JSON.stringify(inPopup)}`)
    browser.stopFind()
    await browser.configure({ zoomFactor: 1.25 })
    const zoomed = browser.state().tabs.find((tab) => tab.id === browser.state().activeTabId)?.settings?.zoomFactor
    if (popup.getZoomFactor() !== 1.25 || zoomed !== 1.25) throw new Error(`Zoom did not reach the sign-in popup: ${popup.getZoomFactor()}, ${zoomed}`)

    console.log(JSON.stringify({ reservedKeyReachesManor: true, pageFirstKeyReachesManor: true, claimedKeyStaysInPage: true,
      pageMadeKeyIgnored: true, findOpens: true, findCounts: true, reopenClosedTab: true, signInPopupKeys: true, signInPopupFindZoom: true }))
  } finally {
    await browser.close()
    server.close()
    app.quit()
  }
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
