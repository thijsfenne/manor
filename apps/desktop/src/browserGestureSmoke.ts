import { createServer } from 'node:http'
import { app, session } from 'electron'
import { BrowserHost } from './browserHost'
import { browserSmokeWindow, mountSmokeWebviews } from './browserSmokeWindow'
import { BrowserWebviews } from './browserWebviews'

/**
 * Trackpad gestures as trusted wheel events in a real guest: pinch, pan past the
 * magnified edge, and sideways swipes on a plain page and on a canvas that pans itself.
 * Native input does not move the user's pointer.
 */
const pages: Record<string, string> = {
  '/': '<title>Start</title><p>Start</p>',
  '/long': '<title>Long</title><body style="margin:0;height:3000px"><p>Long page</p></body>',
  '/snap': `<title>Snap</title><style>html{scroll-snap-type:y mandatory}body{margin:0}section{height:100vh;scroll-snap-align:start}</style>
    <section>One</section><section>Two</section><section>Three</section>`,
  '/strip': `<title>Strip</title><body style="margin:0"><div id="s" style="overflow-x:auto;height:100vh"><div style="width:300vw;height:100%"></div></div>
    <script>s.scrollLeft = 20</script></body>`,
  '/canvas': `<title>Canvas</title><body style="margin:0;overflow:hidden"><canvas id="c" style="display:block;width:100vw;height:100vh"></canvas>
    <script>globalThis.panned = 0; c.addEventListener('wheel', (e) => { e.preventDefault(); panned += e.deltaX }, { passive: false })</script></body>`,
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html>${pages[request.url ?? '/'] ?? pages['/']}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not reserve the smoke port.')
  const origin = `http://127.0.0.1:${address.port}`

  const window = browserSmokeWindow()
  const profile = session.fromPartition('manor-browserGestureSmoke')
  const registry = new BrowserWebviews(window, profile)
  await mountSmokeWebviews(window, registry)
  const browser = new BrowserHost(window, profile, () => {}, registry)
  const url = () => browser.state().tabs.find((tab) => tab.id === browser.state().activeTabId)?.url ?? ''
  const magnified = () => registry.list().surfaces[0]?.magnify
  try {
    await browser.setVisible(true)
    await browser.setBounds({ x: 0, y: 0, width: 800, height: 600 })
    await browser.navigate(origin)
    await browser.navigate(`${origin}/long`)
    const page = browser.previewTarget()?.contents
    if (!page) throw new Error('The smoke browser has no page.')
    window.show()
    page.focus()
    const evaluate = (expression: string) => page.executeJavaScript(expression) as Promise<number>
    // Electron's wheel deltas point the way content moves, the DOM's the way the page scrolls.
    const wheel = async (deltaX: number, deltaY: number, modifiers: ('control')[] = []) => {
      page.sendInputEvent({ type: 'mouseWheel', x: 400, y: 300, deltaX: -deltaX, deltaY: -deltaY,
        hasPreciseScrollingDeltas: true, canScroll: true, modifiers })
      await pause(16)
    }
    const settle = async (want: () => boolean | Promise<boolean>, what: string) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await want()) return
        await pause(50)
      }
      throw new Error(what)
    }

    // Pinch to 2x, then move down: the magnified view reaches its edge, then the page scrolls.
    for (let step = 0; step < 30 && (magnified()?.scale ?? 1) < 2; step += 1) await wheel(0, -10, ['control'])
    await settle(() => (magnified()?.scale ?? 1) >= 2, `Pinch did not magnify: ${JSON.stringify(magnified())}`)
    const scale = magnified()!.scale
    if (page.getZoomFactor() !== 1) throw new Error('Pinch changed the page zoom.')
    for (let step = 0; step < 20; step += 1) await wheel(0, 30)
    await settle(() => Math.abs(magnified()!.y - (1 - 1 / scale)) < 0.001, `Magnified view never reached its edge: ${JSON.stringify(magnified())}`)
    await settle(async () => await evaluate('scrollY') > 0, 'Moving past the magnified edge did not scroll the page.')
    const scrolledAfterEdge = await evaluate('scrollY')
    // Back up: the magnified view moves first while the page stays.
    await wheel(0, -30)
    await settle(() => magnified()!.y < 1 - 1 / scale - 0.001, 'Moving up did not pan the magnified view.')
    if (await evaluate('scrollY') !== scrolledAfterEdge) throw new Error('Moving up scrolled the page before the magnified view.')
    const unpinch = async () => {
      for (let step = 0; step < 30 && magnified() !== undefined; step += 1) await wheel(0, 30, ['control'])
      await settle(() => magnified() === undefined, 'Pinching back did not end the magnification.')
      await pause(600)
    }
    await unpinch()

    // A scroll-snap page snaps small steps back, so past the edge it scrolls its own way.
    await browser.navigate(`${origin}/snap`)
    await pause(300)
    for (let step = 0; step < 30 && (magnified()?.scale ?? 1) < 2; step += 1) await wheel(0, -10, ['control'])
    for (let step = 0; step < 40; step += 1) await wheel(0, 30)
    await settle(async () => await evaluate('scrollY') > 0, 'A magnified scroll-snap page did not scroll past the edge.')
    const snappedTo = await evaluate('scrollY')
    await unpinch()

    // A strip that one wheel step carries to its edge still took the gesture.
    await browser.navigate(`${origin}/strip`)
    await pause(300)
    await wheel(-200, 0)
    for (let step = 0; step < 40; step += 1) await wheel(-25, 0)
    await pause(600)
    if (url() !== `${origin}/strip`) throw new Error(`A strip scroll went back to ${url()}.`)
    if (await evaluate('s.scrollLeft') !== 0) throw new Error('The strip did not scroll to its edge.')

    // A canvas that pans itself keeps a sideways swipe; it never goes back.
    await browser.navigate(`${origin}/canvas`)
    await pause(300)
    for (let step = 0; step < 40; step += 1) await wheel(-25, 0)
    await pause(600)
    if (url() !== `${origin}/canvas`) throw new Error(`A canvas pan went back to ${url()}.`)
    // Past the swipe threshold, so only the canvas claiming it kept the page.
    const panned = await evaluate('panned')
    if (panned > -320) throw new Error(`The canvas did not pan past a swipe: ${panned}.`)

    // A plain page at its left edge still goes back with fingers to the right.
    await browser.navigate(`${origin}/long`)
    await pause(300)
    for (let step = 0; step < 40; step += 1) await wheel(-25, 0)
    await settle(() => url() === `${origin}/canvas`, `A swipe at the left edge did not go back: ${url()}`)

    // Manor's own zoom control still sets the page zoom.
    await browser.configure({ zoomFactor: 1.5 })
    if (page.getZoomFactor() !== 1.5) throw new Error(`Page zoom is ${page.getZoomFactor()} instead of 1.5.`)

    console.log(JSON.stringify({ pinchScale: scale, scrolledAfterEdge, snappedTo, canvasPanned: panned, swipedBackTo: url(), pageZoom: page.getZoomFactor() }, null, 2))
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
