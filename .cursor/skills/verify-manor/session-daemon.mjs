#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const SKILL_DIR = dirname(fileURLToPath(import.meta.url))
const ORIGIN = process.env.MANOR_VERIFY_ORIGIN ?? 'http://127.0.0.1:43180'
const PORT = Number(process.env.MANOR_VERIFY_SESSION_PORT ?? 9334)
const READY_PATH = process.env.MANOR_VERIFY_READY ?? join(SKILL_DIR, '.run', 'session.ready')

if (/:(43179|5173)$/.test(ORIGIN.replace(/\/$/, ''))) {
  console.error(`Refusing origin ${ORIGIN}`)
  process.exit(1)
}

// Software compositing of the idle animations kept about eight cores busy per spike;
// ANGLE on Metal draws the same pixels on the GPU at under one core.
// Headless Chromium hides every scrollbar unless told otherwise; `classic` draws them,
// as macOS does with "Show scroll bars: Always" or a mouse connected.
const classicScrollbars = process.env.MANOR_VERIFY_SCROLLBARS === 'classic'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal'],
  ...(classicScrollbars ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}),
})
// Chromium runs in its own process group; the registry needs its pid to stop it.
// Playwright's own SIGTERM handler closes the browser but leaves this server listening.
process.once('SIGTERM', () => {
  browser.close().catch(() => {}).finally(() => process.exit(0))
})
const browserPid = Number(execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  .split('\n').map((line) => line.trim().split(/\s+/)).find(([, ppid, command]) => Number(ppid) === process.pid && /chrom/i.test(command ?? ''))?.[0])
const VIEWPORT = { width: 1280, height: 800 }
const page = await browser.newPage({ viewport: VIEWPORT })
// A stand-in for a native bridge, e.g. `stubs/desktop-browser.js` for the Browser tab strip.
if (process.env.MANOR_VERIFY_INIT_SCRIPT) await page.addInitScript({ path: resolve(process.env.MANOR_VERIFY_INIT_SCRIPT) })
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
try {
  await page.getByRole('navigation', { name: 'Destinations' }).waitFor({ timeout: 30_000 })
} catch (error) {
  const text = await page.locator('body').innerText().catch(() => '')
  throw new Error(`${error instanceof Error ? error.message : error}\nPage text:\n${text}`)
}

// `--frame "A>B"` descends through iframes by title: a delivered HTML preview is
// `Preview of x.html>x.html`, its page top-level (after `open`) is `x.html`.
function frameScope(frame) {
  return String(frame).split('>').reduce((scope, title) => scope.frameLocator(`iframe[title=${JSON.stringify(title)}]`).first(), page)
}

const hasLocator = (flags) => Boolean(flags.role || flags.name || flags.composer || flags.placeholder)

// `--within main` scopes to a landmark; `--role` alone takes the first match.
function locatorFor(flags) {
  // The composer editor is unnamed and shares its landmark with draft fields; this
  // attribute is the one handle that always means the message box.
  if (flags.composer) return page.locator('[data-composer-editor="true"]:visible').first()
  // --frame "<iframe title>" looks inside that iframe, e.g. a delivered HTML preview.
  const scope = flags.frame ? frameScope(flags.frame) : page
  // --within-name picks one landmark of that role, e.g. navigation "Settings" beside the rail.
  const root = flags.within
    ? (flags['within-name'] ? scope.getByRole(flags.within, { name: String(flags['within-name']), exact: true }) : scope.getByRole(flags.within).first())
    : scope
  // --nth picks one of several same-named matches, e.g. the second pane's "Session" door in a split.
  const pick = (locator) => (flags.nth === undefined ? locator : locator.nth(Number(flags.nth)))
  if (flags.placeholder) return pick(root.getByPlaceholder(flags.placeholder))
  if (flags.role && flags.name) return pick(root.getByRole(flags.role, { name: flags.name, exact: flags.exact === true || flags.exact === 'true' }))
  if (flags.role) return flags.nth === undefined ? root.getByRole(flags.role).first() : root.getByRole(flags.role).nth(Number(flags.nth))
  if (flags.name) return pick(root.getByRole('button', { name: flags.name }))
  throw new Error('Need --composer, --role (optionally with --name and --within), or --placeholder')
}

// The agent reads `<name>.preview.png`; the full-size file at --path is the evidence.
const PREVIEW_WIDTH = 800
let previewPage

function pngSize(png) {
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

// Downscales the same pixels in a second page, so preview and evidence never differ.
async function writePreview(png, dest) {
  const [width, height] = pngSize(png)
  if (width <= PREVIEW_WIDTH) return { preview: dest, previewSize: `${width}x${height}` }
  const w = PREVIEW_WIDTH, h = Math.round((height * PREVIEW_WIDTH) / width)
  previewPage ??= await browser.newPage()
  await previewPage.setViewportSize({ width: w, height: h })
  await previewPage.setContent(`<body style="margin:0"><img style="display:block;width:${w}px;height:${h}px" src="data:image/png;base64,${png.toString('base64')}"></body>`)
  await previewPage.locator('img').evaluate((img) => img.decode())
  const preview = dest.replace(/(\.png)?$/i, '.preview.png')
  await previewPage.screenshot({ path: preview })
  return { preview, previewSize: `${w}x${h}` }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function handle(body) {
  const { cmd, flags = {} } = body
  if (cmd === 'ping') return { url: page.url() }
  // A warm spike's next `launch`: the starting viewport and a reload of the origin,
  // so a rebuilt SPA or a restarted server is what the page shows.
  if (cmd === 'reset') {
    await page.setViewportSize(VIEWPORT)
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
    await page.getByRole('navigation', { name: 'Destinations' }).waitFor()
    return { url: page.url() }
  }
  if (cmd === 'home') {
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
    await page.getByRole('navigation', { name: 'Destinations' }).waitFor()
    return { url: page.url() }
  }
  // A path on the spike origin only, e.g. a delivered file's `?view=1` page opened top-level.
  if (cmd === 'open') {
    const target = new URL(String(flags.url ?? ''), ORIGIN)
    if (target.origin !== new URL(ORIGIN).origin) throw new Error('open takes a path or URL on the spike origin')
    await page.goto(target.href, { waitUntil: 'domcontentloaded' })
    return { url: page.url() }
  }
  if (cmd === 'snapshot') {
    // --role/--name (and --within, --composer, --placeholder) read one element instead of the page.
    const body = hasLocator(flags) ? locatorFor(flags) : flags.frame ? frameScope(flags.frame).locator('body') : page.locator('body')
    const text = flags.aria ? await body.ariaSnapshot() : await body.innerText()
    // Without --path the tree comes back to the caller instead of a file named "undefined".
    if (!flags.path) return { text }
    const dest = resolve(String(flags.path))
    writeFileSync(dest, text + '\n')
    return { path: dest }
  }
  if (cmd === 'screenshot') {
    if (!flags.path) throw new Error('screenshot needs --path')
    const dest = resolve(String(flags.path))
    // A locator crops to that element, e.g. one sidebar.
    const png = hasLocator(flags) ? await locatorFor(flags).screenshot({ path: dest }) : await page.screenshot({ path: dest, fullPage: false })
    return { path: dest, size: pngSize(png).join('x'), ...(await writePreview(png, dest)) }
  }
  if (cmd === 'click') {
    const clickCount = Number(flags.count ?? 1)
    if (!Number.isInteger(clickCount) || clickCount < 1) throw new Error('click --count takes a whole number above 0')
    // `--modifiers Meta,Shift` holds those keys for the click, as a pick of several rows does.
    const modifiers = String(flags.modifiers ?? '').split(',').filter(Boolean)
    await locatorFor(flags).click({ clickCount, modifiers, ...(flags.button === 'right' ? { button: 'right' } : {}) })
    await page.waitForTimeout(200)
    return { clicked: flags.name ?? flags.placeholder }
  }
  // Rests the pointer on the element, long enough for a hover card's open delay.
  if (cmd === 'hover') {
    await locatorFor(flags).hover()
    await page.waitForTimeout(600)
    return { hovered: flags.name ?? flags.placeholder }
  }
  // Hands files to the page's first file input, which on a chat stage is the composer's.
  if (cmd === 'attach') {
    const files = String(flags.file ?? '').split(',').filter(Boolean).map((file) => resolve(file))
    if (files.length === 0) throw new Error('attach needs --file <path>[,<path>…]')
    await page.locator('input[type="file"]').first().setInputFiles(files)
    await page.waitForTimeout(400)
    return { attached: files.length }
  }
  // The system colour scheme the page sees; Manor follows it until a theme is picked.
  if (cmd === 'scheme') {
    if (flags.value !== 'light' && flags.value !== 'dark') throw new Error('scheme takes --value light|dark')
    await page.emulateMedia({ colorScheme: flags.value })
    await page.waitForTimeout(300)
    return { scheme: flags.value }
  }
  if (cmd === 'fill') {
    await locatorFor(flags).fill(String(flags.value ?? ''))
    return { filled: flags.name ?? flags.placeholder }
  }
  if (cmd === 'type') {
    await page.keyboard.type(String(flags.text ?? ''))
    return {}
  }
  if (cmd === 'press') {
    await page.keyboard.press(String(flags.key))
    return { key: flags.key }
  }
  if (cmd === 'resize') {
    await page.setViewportSize({ width: Number(flags.width), height: Number(flags.height ?? 800) })
    await page.waitForTimeout(300)
    return { width: Number(flags.width), height: Number(flags.height ?? 800) }
  }
  // A real wheel over the located element; negative `dy` scrolls up.
  if (cmd === 'wheel') {
    const box = await locatorFor(flags).boundingBox()
    if (box === null) throw new Error('Nothing visible to scroll over')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, Number(flags.dy ?? -600))
    await page.waitForTimeout(400)
    return { dy: Number(flags.dy ?? -600) }
  }
  // Press, move by `dx`/`dy` in small steps (as a hand would), release: a resize grip, a tab, a note picture.
  if (cmd === 'drag') {
    // Checked before pressing: Playwright cannot release at a bad coordinate either.
    const dx = Number(flags.dx ?? 0), dy = Number(flags.dy ?? 0), steps = Number(flags.steps ?? 20)
    if (!Number.isFinite(dx)) throw new Error('drag --dx takes a number of pixels')
    if (!Number.isFinite(dy)) throw new Error('drag --dy takes a number of pixels')
    if (!Number.isInteger(steps) || steps < 1) throw new Error('drag --steps takes a whole number above 0')
    const box = await locatorFor(flags).boundingBox()
    if (box === null) throw new Error('Nothing visible to drag')
    // `--from left` presses just inside the left edge, so a drag can select a line from its first letter.
    const x = flags.from === 'left' ? box.x + 1 : box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    // Always let go, so a failed move cannot leave the button held for the next check.
    try { await page.mouse.move(x + dx, y + dy, { steps }) } finally { await page.mouse.up() }
    await page.waitForTimeout(300)
    return { dx, dy, steps }
  }
  // Files from disk dragged onto the located element through Chromium's own drag pipeline
  // (CDP Input.dispatchDragEvent), like a drag from the desktop: the drop only fires when the
  // page accepted the dragover, so check the page afterwards for what it did with them.
  if (cmd === 'drop-files') {
    const files = String(flags.file ?? '').split(',').filter(Boolean).map((file) => resolve(file))
    if (files.length === 0 || typeof flags.file !== 'string') throw new Error('drop-files needs --file <path>[,<path>…]')
    const missing = files.find((file) => !statSync(file, { throwIfNoEntry: false })?.isFile())
    if (missing !== undefined) throw new Error(`No file at ${missing}; give absolute paths`)
    const box = await locatorFor(flags).boundingBox()
    if (box === null) throw new Error('Nothing visible to drop on')
    const x = Math.round(box.x + box.width / 2 + Number(flags.dx ?? 0)), y = Math.round(box.y + Number(flags.dy ?? box.height / 2))
    const cdp = await page.context().newCDPSession(page)
    const data = { items: [], files, dragOperationsMask: 1 }
    try {
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })
    } finally {
      await cdp.detach().catch(() => {})
    }
    await page.waitForTimeout(600)
    return { files: files.length, x, y }
  }
  if (cmd === 'wait-settle') {
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(400)
    return {}
  }
  if (cmd === 'shutdown') {
    setTimeout(async () => {
      await browser.close()
      process.exit(0)
    }, 50)
    return { shuttingDown: true }
  }
  throw new Error(`Unknown session command ${cmd}`)
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, url: page.url() }))
    return
  }
  try {
    const body = await readBody(req)
    const result = await handle(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...result }))
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(READY_PATH, JSON.stringify({ pid: process.pid, port: PORT, origin: ORIGIN, browserPid }) + '\n')
  console.log(JSON.stringify({ ready: true, pid: process.pid, port: PORT }))
})
