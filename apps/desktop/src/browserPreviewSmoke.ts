import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { app, BrowserWindow, nativeImage, session, webContents } from 'electron'
import type { BrowserPreviewUpdate } from '@manor/contracts'
import { BrowserManager } from './browserManager'
import { browserSmokeWindow, mountSmokeWebviews } from './browserSmokeWindow'

app.whenReady().then(async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<style>body{background:white}@keyframes move{to{transform:translateX(150px)}}#moving{position:absolute;top:20px;width:50px;height:50px;background:red;animation:move .4s infinite alternate linear}</style><div id="moving"></div><button id="right" style="position:absolute;right:30px;bottom:100px" onclick="document.title=\'clicked\'">Target</button>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No smoke port.')
  const url = `http://127.0.0.1:${address.port}/`
  const window = browserSmokeWindow()
  const profilePath = mkdtempSync(path.join(tmpdir(), 'manor-guest-profile-'))
  const profile = session.fromPath(profilePath)
  const updates: BrowserPreviewUpdate[] = []
  const browser = new BrowserManager(window, profile, undefined, undefined, undefined, undefined, (update) => updates.push(update))
  await mountSmokeWebviews(window, browser.webviews)
  const bounds = { x: 100, y: 100, width: 900, height: 650 }
  try {
    await browser.startPreview('smoke', 'agent')
    await browser.newTab('smoke', url)
    const page = webContents.getAllWebContents().find((contents) => contents.getURL() === url)
    if (!page) throw new Error('No browser guest.')
    if (page.getType() !== 'webview' || page.session !== profile) throw new Error('Guest uses the wrong type or profile.')
    const id = page.id
    const viewport = () => page.executeJavaScript('`${innerWidth}x${innerHeight}`') as Promise<string>
    const checkViewport = async (expected: string) => {
      for (let n = 0; n < 30; n++) { if (await viewport() === expected) return; await wait(25) }
      throw new Error(`Expected ${expected}, got ${await viewport()}`)
    }
    const click = async () => {
      await page.executeJavaScript("document.title=''")
      await browser.click('#right', 'smoke')
      if (page.getTitle() !== 'clicked') throw new Error('Agent click missed its target.')
    }
    await checkViewport('1280x720')
    await click()
    await browser.show(bounds, 'smoke')
    await checkViewport('900x650')
    await click()
    await page.executeJavaScript('globalThis.smokeIdentity=Math.random();localStorage.setItem("smoke","keep")')
    const identity = await page.executeJavaScript('smokeIdentity')
    await window.webContents.executeJavaScript("const popup=document.createElement('div');popup.id='popup';popup.style.cssText='position:fixed;z-index:20;left:150px;top:150px;width:200px;height:200px;background:rgb(0,255,0)';document.body.append(popup)")
    await wait(80)
    const image = await window.webContents.capturePage()
    const ratio = image.getSize().width / window.getContentSize()[0]!
    const pixel = image.crop({ x: Math.round(200 * ratio), y: Math.round(200 * ratio), width: 1, height: 1 }).toBitmap()
    if (pixel[1]! < 240 || pixel[0]! > 20 || pixel[2]! > 20) throw new Error(`Popup behind guest: ${[...pixel]}`)
    await checkViewport('900x650')
    if (page.id !== id || await page.executeJavaScript('smokeIdentity') !== identity) throw new Error('Popup replaced the page.')
    await window.webContents.executeJavaScript("document.getElementById('popup').remove()")
    await browser.show({ x: 400, y: 100, width: 384, height: 216 }, 'smoke', undefined, 'floating')
    await checkViewport('1280x720')
    await click()
    await browser.show(bounds, 'smoke')
    await checkViewport('900x650')
    if (await page.executeJavaScript('smokeIdentity') !== identity) throw new Error('Floating replaced the page.')
    await browser.configure('smoke', { viewport: { width: 390, height: 844 } })
    await checkViewport('390x844'); await click()
    await browser.show({ x: 400, y: 100, width: 384, height: 216 }, 'smoke', undefined, 'floating')
    await checkViewport('390x844'); await click()
    await browser.show(bounds, 'smoke')
    await browser.configure('smoke', { viewport: { width: 844, height: 390 }, appearance: 'dark' })
    await checkViewport('844x390'); await click()
    if (!await page.executeJavaScript('matchMedia("(prefers-color-scheme: dark)").matches')) throw new Error('Appearance missing.')
    const surface = browser.webviews.list().surfaces[0]!
    if (surface.bounds.y !== 230 || surface.bounds.height !== 390) throw new Error('Responsive centering changed.')
    await browser.openPreviewWindow('smoke')
    const mirror = BrowserWindow.getAllWindows().find((candidate) => candidate !== window)
    if (!mirror) throw new Error('No passive preview window.')
    await wait(600)
    const frame = await mirror.webContents.executeJavaScript("document.getElementById('preview').src") as string
    if (nativeImage.createFromDataURL(frame).isEmpty()) throw new Error('Mirror is empty.')
    await wait(180)
    if (await mirror.webContents.executeJavaScript("document.getElementById('preview').src") === frame) throw new Error('Mirror is not live.')
    if (page.id !== id || await page.executeJavaScript('smokeIdentity') !== identity) throw new Error('Pop-out replaced the page.')
    mirror.close(); await click()
    const loaded = new Promise<void>((resolve) => page.once('did-finish-load', () => resolve()))
    await browser.hardReload('smoke'); await loaded
    await checkViewport('844x390'); await click()
    await browser.configure('smoke', { viewport: null, zoomFactor: 1.25 })
    await click()
    await browser.configure('smoke', { zoomFactor: 1 })
    await browser.openDevTools('smoke'); await wait(150)
    page.closeDevTools(); await wait(250); await click()
    await browser.stopPreview('agent')
    if (updates.at(-1)?.status !== 'stopped' || updates.at(-2)?.status !== 'frame') throw new Error('Final frame was not delivered before stop.')
    await browser.startPreview('smoke', 'manual', 'manual')
    await browser.endAgentUse('smoke')
    if (updates.at(-1)?.status !== 'frame') throw new Error('Agent completion stopped manual preview.')
    await browser.stopPreview('manual')
    await browser.configure('smoke', { viewport: { width: 390, height: 844 }, appearance: 'dark', zoomFactor: 1.25 })
    const beforeCrash = await viewport()
    const crashed = new Promise<void>((resolve) => page.once('destroyed', () => resolve()))
    page.forcefullyCrashRenderer()
    await crashed
    await browser.show(bounds, 'smoke')
    const recovered = webContents.getAllWebContents().find((contents) => contents.getURL() === url && contents.id !== id)
    if (!recovered || recovered.session !== profile || recovered.getZoomFactor() !== 1.25 ||
        await recovered.executeJavaScript('`${innerWidth}x${innerHeight}`') !== beforeCrash ||
        !await recovered.executeJavaScript('matchMedia("(prefers-color-scheme: dark)").matches && localStorage.getItem("smoke")==="keep"')) throw new Error('Crash recovery: ' + JSON.stringify({exists:!!recovered,session:recovered?.session===profile,zoom:recovered?.getZoomFactor(),document:await recovered?.executeJavaScript('[innerWidth,innerHeight,matchMedia("(prefers-color-scheme: dark)").matches,localStorage.getItem("smoke")]')}))
    const token = browser.webviews.list().surfaces[0]!
    await browser.close('smoke')
    if (browser.webviews.list().surfaces.length) throw new Error('Closing chat leaked the guest.')
    let staleRejected = false
    try { browser.webviews.presented(token.id, token.token, token.revision) } catch { staleRejected = true }
    if (!staleRejected) throw new Error('Stale acknowledgement accepted.')
    console.log(JSON.stringify({ sameGuest: true, popupLayering: true, sidebarFloat: true, responsive: true, agentClicks: true, passiveLiveMirror: true, finalFrame: true, manualOwnership: true, cleanup: true, fromPathProfile: true, crashRecovery: true }))
  } finally {
    await browser.closeAll()
    window.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(profilePath, { recursive: true, force: true })
    app.quit()
  }
}).catch((error: unknown) => { console.error(error); app.exit(1) })

async function wait(ms: number): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, ms)) }
