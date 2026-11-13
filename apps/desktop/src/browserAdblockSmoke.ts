import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { app, ipcMain, session, webContents } from 'electron'
import { BrowserAdblock } from './browserAdblock'
import { ADBLOCK_PRELOAD_PATH, buildAdblockEngine, loadAdblockEngine } from './browserAdblockRuntime'
import { BrowserHost } from './browserHost'
import { PasswordAutofill } from './browserPasswordAutofill'
import { BrowserPasswordStore } from './browserPasswords'
import { browserSmokeWindow, mountSmokeWebviews } from './browserSmokeWindow'
import { BrowserWebviews } from './browserWebviews'

/**
 * The real list download, utility-process build, session hooks and a live ad test
 * page. Needs the network. `MANOR_ADBLOCK_SMOKE_URL` swaps the page; with
 * `MANOR_SMOKE_EVIDENCE_DIR` set it keeps pictures of the page with blocking on and off.
 */
const AD_PAGE = process.env.MANOR_ADBLOCK_SMOKE_URL || 'https://d3ward.github.io/toolz/adblock.html'
const LOGIN = `<!doctype html><html><head><title>Sign in</title></head><body><form action="/done" method="post">
  <input id="user" type="email" autocomplete="username" /><input id="pass" type="password" autocomplete="current-password" />
  <button id="go" type="submit">Sign in</button></form></body></html>`

app.whenReady().then(async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'manor-adblock-smoke-'))
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(LOGIN) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not reserve the smoke port.')

  const window = browserSmokeWindow()
  const profile = session.fromPartition('manor-browserAdblockSmoke')
  await profile.clearData()
  const registry = new BrowserWebviews(window, profile)
  await mountSmokeWebviews(window, registry)
  const options = {
    directory: path.join(root, 'adblock'),
    ipcMain,
    contentsById: (id: number) => webContents.fromId(id),
    buildEngine: buildAdblockEngine,
    loadEngine: loadAdblockEngine,
    preloadPath: ADBLOCK_PRELOAD_PATH,
    log: (message: string) => console.log(message),
  }
  const adblock = new BrowserAdblock(options)
  adblock.attach(profile)
  const store = new BrowserPasswordStore(path.join(root, 'passwords.sqlite'), {
    encrypt: (plaintext) => Buffer.from(plaintext).reverse(),
    decrypt: (encrypted) => Buffer.from(encrypted).reverse().toString(),
  })
  const browser = new BrowserHost(window, profile, () => {}, registry, undefined, undefined, undefined, undefined,
    new PasswordAutofill(store, ipcMain), adblock)
  // The request log: what the engine cancelled, and what reached a server.
  const blockedUrls: string[] = []
  const completedHosts = new Set<string>()
  profile.webRequest.onErrorOccurred((details) => { if (details.error === 'net::ERR_BLOCKED_BY_CLIENT') blockedUrls.push(details.url) })
  profile.webRequest.onCompleted((details) => { completedHosts.add(new URL(details.url).hostname) })
  const active = () => {
    const state = browser.state()
    const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
    if (tab === undefined) throw new Error('The smoke browser has no active tab.')
    return tab
  }
  const page = () => {
    const contents = browser.previewTarget()?.contents
    if (contents === undefined) throw new Error('The smoke browser has no native page.')
    return contents
  }
  const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const evidence = async (name: string) => {
    const dir = process.env.MANOR_SMOKE_EVIDENCE_DIR
    if (dir === undefined || dir === '') return
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, name), (await page().capturePage()).toPNG())
  }

  try {
    const building = Date.now()
    await adblock.start()
    console.log(`lists built in a utility process in ${Date.now() - building} ms`)
    adblock.stop()

    await browser.setVisible(true)
    await browser.setBounds({ x: 0, y: 0, width: 1000, height: 780 })
    window.show()
    await browser.navigate(AD_PAGE)
    await settle(8_000)
    // A news site may bounce a fresh profile through its consent host first; the switch
    // must be judged on the ad page itself, so come back to it once.
    if (new URL(page().getURL()).hostname !== new URL(AD_PAGE).hostname) {
      blockedUrls.length = 0
      await browser.navigate(AD_PAGE)
      await settle(8_000)
    }
    if (new URL(page().getURL()).hostname !== new URL(AD_PAGE).hostname) throw new Error(`The smoke is stuck on ${page().getURL()}.`)
    const on = active().adblock
    const blockedHosts = new Set(blockedUrls.map((url) => new URL(url).hostname))
    console.log(`blocking on: count ${on?.blocked}, ${blockedUrls.length} cancelled requests over ${blockedHosts.size} hosts`)
    console.log(`  e.g. ${[...blockedHosts].slice(0, 8).join(', ')}`)
    if (on?.blocking !== true || on.blocked === 0 || blockedUrls.length === 0) {
      throw new Error(`Nothing was blocked on ${page().getURL()}: ${JSON.stringify(on)}; hosts answered: ${[...completedHosts].join(', ')}`)
    }
    await evidence('adblock-on.png')

    blockedUrls.length = 0
    completedHosts.clear()
    await browser.setSiteAdblock(false)
    await settle(8_000)
    const off = active().adblock
    const restored = [...blockedHosts].filter((host) => completedHosts.has(host))
    console.log(`blocking off: count ${off?.blocked}, ${blockedUrls.length} cancelled, ${restored.length} formerly blocked hosts answered`)
    if (off?.blocking !== false || off.blocked !== 0 || blockedUrls.length !== 0 || restored.length === 0) {
      throw new Error(`The switch did not restore the ads: ${JSON.stringify(off)}`)
    }
    await evidence('adblock-off.png')

    // A restart reads the same switch from disk.
    adblock.detach()
    ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters')
    ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled')
    const restarted = new BrowserAdblock(options)
    if (restarted.state(undefined, page().getURL())?.blocking !== false) throw new Error('The switch was forgotten after a restart.')
    console.log('switch still off after a restart')
    restarted.attach(profile)
    // The cached engine loads, so the fill below runs with blocking and its preload live.
    await restarted.start()
    restarted.stop()

    // A saved login still fills on the user's click with the blocker and its preload attached.
    const origin = `http://127.0.0.1:${address.port}`
    store.save(origin, 'sam@example.invalid', 'correct horse')
    await browser.navigate(`${origin}/login`)
    const login = active().passwords?.logins[0]
    if (login === undefined) throw new Error('The saved login is not offered.')
    browser.fillPassword(login.id)
    await settle(300)
    const filled = await page().executeJavaScript(`({ user: user.value, pass: pass.value === 'correct horse' })`) as { user: string; pass: boolean }
    if (filled.user !== 'sam@example.invalid' || !filled.pass) throw new Error(`The fill did not land: ${JSON.stringify(filled)}`)
    console.log('saved login filled with the blocker attached')
    console.log('browser adblock smoke ok')
  } finally {
    await browser.close()
    server.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
    app.quit()
  }
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
