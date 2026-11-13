import { browserSmokeWindow, mountSmokeWebviews } from './browserSmokeWindow'
import { BrowserWebviews } from './browserWebviews'
import { createServer } from 'node:http'
import { app, nativeImage, session } from 'electron'
import { BrowserCursor } from './browserCursor'
import { withBrowserInput } from './browserInputAction'
import { BrowserHost } from './browserHost'

/** One transparent pixel, so the favicon path is exercised without a network. */
const ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const form = `<!doctype html>
<html>
  <head><title>Browser interaction smoke</title><link rel="icon" href="/favicon.png" /></head>
  <body style="min-height: 2400px">
    <label>Name <input id="name" /></label>
    <button id="submit" onmousedown="this.dataset.pressed = String(event.isTrusted)" onclick="document.title = 'Submitted'; document.querySelector('#output').textContent = 'Hello ' + document.querySelector('#name').value + (event.isTrusted && this.dataset.pressed === 'true' ? ' via mouse' : ' via script')">Submit</button>
    <p id="output"></p>
  </body>
</html>`

const second = `<!doctype html>
<html><head><title>Second page</title></head><body><p>Second page</p></body></html>`

app.whenReady().then(async () => {
  const server = createServer((request, response) => {
    if (request.url === '/favicon.png') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(ICON)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(request.url === '/second' ? second : form)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not reserve the smoke port.')
  const origin = `http://127.0.0.1:${address.port}`

  // Native mouse dispatch needs an active widget; DOM clicks hid that requirement.
  const window = browserSmokeWindow()
  const profile = session.fromPartition('manor-browserInteractionSmoke')
  const registry = new BrowserWebviews(window, profile)
  await mountSmokeWebviews(window, registry)
  let changes = 0
  const browser = new BrowserHost(window, profile, () => { changes += 1 }, registry)
  const activeTab = () => {
    const state = browser.state()
    return state.tabs.find((tab) => tab.id === state.activeTabId)
  }
  currentUrl = () => activeTab()?.url ?? ''
  settledFavicon = async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      const mark = activeTab()?.favicon
      if (mark !== undefined) return mark
    }
    throw new Error('The tab never received the page mark.')
  }
  try {
    await browser.setVisible(true)
    await browser.setBounds({ x: 0, y: 0, width: 800, height: 600 })
    await browser.navigate(origin)
    const page = browser.previewTarget()?.contents
    if (!page) throw new Error('The smoke browser has no native page.')
    window.show()
    page.focus()
    const cursorCount = () => page.executeJavaScript('document.querySelectorAll("[data-manor-browser-cursor]").length') as Promise<number>
    const cursor = new BrowserCursor(page)
    await cursor.show('move', { x: 20, y: 20 })
    const surface = await page.executeJavaScript(`(() => {
      const host = document.querySelector('[data-manor-browser-cursor]')
      return {
        topLayer: host?.matches(':popover-open'),
        pointerEvents: host ? getComputedStyle(host).pointerEvents : null,
        interceptsInput: document.elementFromPoint(20, 20) === host,
        privateRoot: host?.shadowRoot === null,
        privateRuntime: globalThis.__manorBrowserCursor === undefined,
      }
    })()`)
    if (!surface.topLayer || surface.pointerEvents !== 'none' || surface.interceptsInput ||
      !surface.privateRoot || !surface.privateRuntime) {
      throw new Error(`Cursor surface is not isolated and pointer-transparent: ${JSON.stringify(surface)}`)
    }
    // An old action's cleanup cannot erase a newer cursor in the same document.
    const nextCursor = new BrowserCursor(page)
    await nextCursor.show('move', { x: 40, y: 40 })
    await cursor.clear()
    if (await cursorCount() !== 1) throw new Error('Old cursor cleanup erased a newer action.')
    await nextCursor.clear()
    if (await cursorCount() !== 0) throw new Error('Cursor surface survived completion.')
    let interrupted = false
    try {
      await withBrowserInput(page, async (input) => {
        await input.showCursor('move', { x: 30, y: 30 })
        // Exercise the native event boundary without moving the real user's pointer.
        page.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 50, y: 50 })
        input.check()
      })
    } catch (error) {
      interrupted = error instanceof Error && error.message.includes('interrupted by human input')
    }
    if (!interrupted || await cursorCount() !== 0) throw new Error('Human input did not clear the cursor.')
    await browser.type('#name', 'Manor')
    await browser.press('Tab')
    if (!await page.executeJavaScript('document.activeElement.id === "submit"')) throw new Error('Tab did not advance native focus.')
    await browser.click('#submit')
    if (await cursorCount() !== 1) throw new Error('The cursor vanished between browser actions.')
    await browser.snapshot()
    if (await cursorCount() !== 1) throw new Error('Reading the page removed the retained cursor.')
    // Native input outside an agent action must also clear the retained cursor.
    page.sendInputEvent({ type: 'mouseDown', button: 'left', x: 400, y: 100, clickCount: 1 })
    page.sendInputEvent({ type: 'mouseUp', button: 'left', x: 400, y: 100, clickCount: 1 })
    for (let attempt = 0; attempt < 20 && await cursorCount() !== 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    if (await cursorCount() !== 0) throw new Error('Human input between actions left the cursor visible.')
    await browser.click('#submit')
    if (await cursorCount() !== 1) throw new Error('The next agent action did not restore the cursor.')
    await browser.endAgentUse()
    if (await cursorCount() !== 0) throw new Error('Ending agent use left the cursor visible.')
    await browser.press('End')
    await browser.scroll(0, 400)
    const [snapshot, screenshot] = await Promise.all([browser.snapshot(), browser.screenshot()])
    if (snapshot.title !== 'Submitted' || !snapshot.visibleText.includes('Hello Manor via mouse')) {
      throw new Error(`Browser interactions ended at title ${JSON.stringify(snapshot.title)} with text ${JSON.stringify(snapshot.visibleText)}.`)
    }

    // The site's own mark, fetched over the browser's session and inlined, so the
    // renderer draws it without Manor's window requesting anything from the page.
    const favicon = await settledFavicon()

    // Back, forward and reload run on the active tab and are the only three things
    // in the toolbar that are not Manor's own invention.
    await browser.navigate(`${origin}/second`)
    if (browser.state().tabs[0]?.canGoBack !== true) throw new Error('History did not record the first page.')
    await browser.goBack()
    // The form's own text was written by a click, so a fresh load of it says nothing
    // about "Hello Manor". Where the tab is, is the honest thing to check.
    await settleAt(`${origin}/`)
    await browser.goForward()
    await settleAt(`${origin}/second`)
    await browser.reload()
    await settleAt(`${origin}/second`)

    // A second tab is a second live page in the same session, and closing the active
    // one hands the session to its neighbour rather than leaving nothing behind.
    await browser.newTab()
    await browser.navigate(origin)
    const twoTabs = browser.state()
    if (twoTabs.tabs.length !== 2 || twoTabs.activeTabId !== twoTabs.tabs[1]?.id) {
      throw new Error(`A new tab did not take over: ${JSON.stringify(twoTabs)}`)
    }
    await browser.closeTab(twoTabs.tabs[1].id)
    const oneTab = browser.state()
    if (oneTab.tabs.length !== 1 || oneTab.activeTabId !== oneTab.tabs[0]?.id) {
      throw new Error(`Closing the active tab stranded the session: ${JSON.stringify(oneTab)}`)
    }

    // Closing the panel parks the session; it does not end it. An agent working in a
    // chat nobody is watching has to keep the same page and the same viewport.
    await browser.setVisible(false)
    const parked = await browser.screenshot()
    if (parked.screenshot.length < screenshot.screenshot.length / 2) {
      throw new Error(`A parked browser stopped rendering: ${parked.screenshot.length} characters.`)
    }
    // Hidden input/capture must wake the same guest, then let it stop drawing again.
    const hiddenStart = performance.now()
    await browser.navigate(origin)
    await browser.type('#name', 'Hidden')
    await browser.click('#submit')
    if (!(await browser.snapshot()).visibleText.includes('Hello Hidden via mouse')) throw new Error('Hidden input failed.')
    const evaluate = async (expression: string) => {
      const result = await page.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
      return result.result.value
    }
    await evaluate('document.body.style.background="rgb(0,255,0)";globalThis.paintFrames=0;requestAnimationFrame(function tick(){paintFrames++;requestAnimationFrame(tick)})')
    const fresh = await browser.screenshot()
    const hiddenActionMs = performance.now() - hiddenStart
    if (hiddenActionMs > 5000) throw new Error(`Hidden actions stalled for ${hiddenActionMs} ms.`)
    const pixel = nativeImage.createFromDataURL(fresh.screenshot).crop({ x: 400, y: 300, width: 1, height: 1 }).toBitmap()
    if (pixel[1]! < 240 || pixel[0]! > 20 || pixel[2]! > 20) throw new Error('Hidden screenshot is stale.')
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    const beforeSleep = await evaluate('paintFrames') as number
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    const sleepingFrames = (await evaluate('paintFrames') as number) - beforeSleep
    if (sleepingFrames > 1) throw new Error(`Hidden capture left the guest painting: ${sleepingFrames} frames.`)
    window.hide()
    const hiddenWindowStart = performance.now()
    await browser.newTab()
    await browser.navigate(origin)
    await browser.configure({ viewport: { width: 390, height: 844 } })
    const hiddenWindowCapture = await browser.screenshot()
    if (nativeImage.createFromDataURL(hiddenWindowCapture.screenshot).isEmpty()) throw new Error('Hidden window capture is empty.')
    const hiddenWindowMs = performance.now() - hiddenWindowStart
    window.show()
    if (changes === 0) throw new Error('The tab strip was never told anything changed.')

    console.log(JSON.stringify({
      cursorSurface: surface,
      title: snapshot.title,
      visibleText: snapshot.visibleText,
      favicon: `${favicon.slice(0, 22)}… (${favicon.length} characters)`,
      snapshotCharacters: JSON.stringify(snapshot).length,
      screenshotCharacters: screenshot.screenshot.length,
      parkedScreenshotCharacters: parked.screenshot.length,
      hiddenInput: true, freshHiddenCapture: true, sleepingFrames, hiddenActionMs, hiddenWindowMs,
      stateChangesPublished: changes,
    }, null, 2))
  } finally {
    await browser.close()
    registry.close()
    window.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    app.quit()
  }
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})

/**
 * History moves and reloads are fire-and-forget in Chromium, so the smoke waits for
 * the tab to actually arrive rather than for a guessed number of milliseconds.
 */
async function settleAt(url: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    if (currentUrl() === url) return
  }
  throw new Error(`The browser stopped at ${currentUrl()} instead of ${url}.`)
}

let currentUrl: () => string = () => ''
let settledFavicon: () => Promise<string> = async () => ''
