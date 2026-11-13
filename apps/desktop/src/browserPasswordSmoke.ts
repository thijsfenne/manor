import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { app, ipcMain, session, webContents } from 'electron'
import { BrowserHost } from './browserHost'
import { PasswordAutofill } from './browserPasswordAutofill'
import { BrowserPasswordStore } from './browserPasswords'
import { browserSmokeWindow, mountSmokeWebviews } from './browserSmokeWindow'
import { BrowserWebviews } from './browserWebviews'

/** Inputs record whether a page listener saw the fill, the way a React form would. */
const login = (action: string) => `<!doctype html>
<html><head><title>Sign in</title></head><body>
  <form action="${action}" method="post">
    <input id="user" name="email" type="email" autocomplete="username" />
    <input id="pass" name="password" type="password" autocomplete="current-password" />
    <button id="show" type="button" onclick="pass.type = 'text'; setTimeout(() => { pass.type = 'password' }, 50)">Show password</button>
    <button id="go" type="submit">Sign in</button>
  </form>
  <button id="popup" style="position:fixed;inset:0 0 auto auto;width:200px;height:120px"
    onclick="window.open('/popup-login', 'signin', 'popup,width=400,height=400')">Popup</button>
  <script>
    for (const input of document.querySelectorAll('input')) input.addEventListener('input', () => { input.dataset.heard = 'yes' })
  </script>
</body></html>`

/** The same login three other ways: a blocking required field, `form="…"` controls, and a username-only first step. */
const variant = (body: string) => `<!doctype html><html><head><title>Sign in</title></head><body>${body}</body></html>`
const pages: Record<string, string> = {
  '/required': variant(`<form action="/done" method="post">
    <input id="user" type="email" autocomplete="username" />
    <input id="pass" type="password" autocomplete="current-password" />
    <input id="code" name="code" required />
    <button id="go" type="submit">Sign in</button>
  </form>`),
  '/associated': variant(`<form id="login-form" action="/done" method="post"></form>
    <input id="user" form="login-form" name="email" type="email" autocomplete="username" />
    <input id="pass" form="login-form" name="password" type="password" autocomplete="current-password" />
    <button id="go" form="login-form" type="submit">Sign in</button>`),
  // Hostile to an agent fill: one page reveals the field from the username's input
  // handler, one echoes the password into its text, the console and a GET address.
  '/reveal-early': variant(`<form action="/done" method="post">
    <input id="user" type="email" autocomplete="username" oninput="pass.type = 'text'" />
    <input id="pass" type="password" autocomplete="current-password" />
  </form>`),
  '/echo': variant(`<form action="/echoed" method="get">
    <input id="user" name="user" type="email" autocomplete="username" />
    <input id="pass" name="password" type="password" autocomplete="current-password" oninput="echo.textContent = this.value; console.log('typed', this.value)" />
    <button id="go" type="submit">Sign in</button>
  </form><p id="echo"></p>`),
  '/hidden-first': variant(`<form action="/done" method="post">
    <input id="decoy" type="password" style="visibility:hidden" />
    <span style="opacity:0"><input id="ghost" type="password" /></span>
    <input id="user" type="email" autocomplete="username" />
    <input id="pass" type="password" autocomplete="current-password" />
  </form>`),
  '/username-step': variant(`<form action="/done" method="post">
    <input id="user" name="email" type="email" autocomplete="username" />
    <button type="submit">Next</button>
  </form>`),
}

app.whenReady().then(async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'manor-password-smoke-'))
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    if (request.url === '/done') response.end('<!doctype html><title>Signed in</title><p>Welcome</p>')
    else if (request.url === '/popup-login') response.end(login('/done'))
    else if (request.url?.startsWith('/echoed') === true) response.end('<!doctype html><title>Echoed</title><p>Signed in</p>')
    else if (request.url !== undefined && request.url in pages) response.end(pages[request.url])
    else response.end(login('/done'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not reserve the smoke port.')
  const origin = `http://127.0.0.1:${address.port}`
  const otherOrigin = `http://localhost:${address.port}`

  const window = browserSmokeWindow()
  const profile = session.fromPartition('manor-browserPasswordSmoke')
  const registry = new BrowserWebviews(window, profile)
  await mountSmokeWebviews(window, registry)
  const store = new BrowserPasswordStore(path.join(root, 'passwords.sqlite'), {
    encrypt: (plaintext) => Buffer.from(plaintext).reverse(),
    decrypt: (encrypted) => Buffer.from(encrypted).reverse().toString(),
  })
  const autofill = new PasswordAutofill(store, ipcMain)
  const browser = new BrowserHost(window, profile, () => {}, registry, undefined, undefined, undefined, undefined, autofill)
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
  /** With MANOR_SMOKE_EVIDENCE_DIR set, keeps a picture of the page as proof. */
  const evidence = async (name: string) => {
    const dir = process.env.MANOR_SMOKE_EVIDENCE_DIR
    if (dir === undefined || dir === '') return
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, name), (await page().capturePage()).toPNG())
  }
  const until = async (label: string, check: () => boolean) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (check()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for ${label}.`)
  }

  try {
    await browser.setVisible(true)
    await browser.setBounds({ x: 0, y: 0, width: 800, height: 600 })
    await browser.navigate(`${origin}/login`)
    window.show()

    // Typed by the page's own script, submitted by a script click: the guest preload sees both.
    await page().executeJavaScript(`
      document.querySelector('#user').value = 'sam@example.invalid'
      document.querySelector('#pass').value = 'correct horse'
      document.querySelector('#go').click()
    `)
    await until('the save offer', () => active().passwords?.offer !== undefined)
    const offer = active().passwords?.offer
    if (offer?.kind !== 'save' || offer.origin !== origin || offer.username !== 'sam@example.invalid') {
      throw new Error(`Unexpected offer ${JSON.stringify(offer)}`)
    }
    if (store.list().length !== 0) throw new Error('A login was stored before the user answered.')
    browser.answerPasswordOffer(active().id, 'save')
    if (active().passwords?.offer !== undefined) throw new Error('The answered offer stayed on the tab.')

    await browser.navigate(`${origin}/login`)
    const saved = active().passwords?.logins
    if (saved?.length !== 1 || saved[0]?.username !== 'sam@example.invalid') throw new Error(`Saved logins missing: ${JSON.stringify(saved)}`)
    browser.fillPassword(saved[0].id)
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    const filled = await page().executeJavaScript(`({
      user: document.querySelector('#user').value,
      pass: document.querySelector('#pass').value,
      heard: document.querySelector('#pass').dataset.heard,
    })`) as { user: string; pass: string; heard?: string }
    if (filled.user !== 'sam@example.invalid' || filled.pass !== 'correct horse' || filled.heard !== 'yes') {
      throw new Error(`The fill did not land: ${JSON.stringify({ ...filled, pass: filled.pass === 'correct horse' })}`)
    }

    // Only a sign-in submits: Show password with a changed value must not offer Update.
    await page().executeJavaScript(`
      document.querySelector('#pass').value = 'typo'
      document.querySelector('#show').click()
    `)
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    if (active().passwords?.offer !== undefined) throw new Error('A Show password click offered to update the login.')

    // A required field left empty blocks the submit, so the changed password is no login.
    await browser.navigate(`${origin}/required`)
    await page().executeJavaScript(`
      document.querySelector('#user').value = 'sam@example.invalid'
      document.querySelector('#pass').value = 'typo'
      document.querySelector('#go').click()
    `)
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    if (active().passwords?.offer !== undefined) throw new Error('A blocked submit offered to update the login.')

    // Controls joined to the form with form="…" fill and capture like nested ones.
    await browser.navigate(`${origin}/associated`)
    await until('the page', () => !page().isLoading())
    browser.fillPassword(saved[0].id)
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    const associated = await page().executeJavaScript(`[document.querySelector('#user').value, document.querySelector('#pass').value]`) as string[]
    if (associated[0] !== 'sam@example.invalid' || associated[1] !== 'correct horse') throw new Error('The form="…" fields did not fill.')
    await page().executeJavaScript(`
      document.querySelector('#user').value = 'other@example.com'
      document.querySelector('#go').click()
    `)
    await until('the form="…" offer', () => active().passwords?.offer?.username === 'other@example.com')
    browser.answerPasswordOffer(active().id, 'dismiss')
    await until('the signed-in page', () => page().getURL().endsWith('/done') && !page().isLoading())

    // The first step of a two-page login has only the username to fill.
    await browser.navigate(`${origin}/username-step`)
    await until('the page', () => !page().isLoading())
    browser.fillPassword(saved[0].id)
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    if (await page().executeJavaScript(`document.querySelector('#user').value`) !== 'sam@example.invalid') {
      throw new Error('The username-only step did not fill.')
    }

    // Same port, another origin: no saved logins, and a forced fill is refused.
    await browser.navigate(`${otherOrigin}/login`)
    if (active().passwords !== undefined) throw new Error('Another origin saw saved logins.')
    let refused = false
    try { browser.fillPassword(saved[0].id) } catch { refused = true }
    if (!refused) throw new Error('A login filled into another origin.')

    // An agent's fill request: lookup, then the fill the user's card approves. Neither answer holds the password.
    await browser.navigate(`${origin}/login`)
    await until('the page', () => !page().isLoading())
    const lookup = await browser.findSavedLogin()
    if (lookup.origin !== origin || lookup.login?.username !== 'sam@example.invalid' || !lookup.passwordField) {
      throw new Error(`Unexpected agent lookup ${JSON.stringify(lookup)}`)
    }
    const agentFilled = await browser.fillSavedLogin({ tabId: lookup.tabId, pageId: lookup.pageId, origin: lookup.origin, loginId: lookup.login.id })
    if (JSON.stringify([lookup, agentFilled]).includes('correct horse')) throw new Error('An agent answer carried the password.')
    const agentForm = await page().executeJavaScript(`[document.querySelector('#user').value, document.querySelector('#pass').value]`) as string[]
    if (agentForm[0] !== 'sam@example.invalid' || agentForm[1] !== 'correct horse') throw new Error('The agent fill did not land.')
    await evidence('agent-fill-filled-form.png')

    // A show-password eye would put the agent-filled password on screen, so the field empties
    // instead, also when the page added to the value first.
    await page().executeJavaScript(`document.querySelector('#pass').value += 'x'`)
    await browser.click('#show')
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    if (await page().executeJavaScript(`document.querySelector('#pass').value`) !== '') {
      throw new Error('Revealing an agent-filled password left it readable.')
    }

    // A hidden password field is no place for the password; the visible one takes it.
    await browser.navigate(`${origin}/hidden-first`)
    await until('the page', () => !page().isLoading())
    const hidden = await browser.findSavedLogin()
    await browser.fillSavedLogin({ tabId: hidden.tabId, pageId: hidden.pageId, origin: hidden.origin, loginId: hidden.login!.id })
    const hiddenForm = await page().executeJavaScript(`[document.querySelector('#decoy').value, document.querySelector('#ghost').value, document.querySelector('#pass').value]`) as string[]
    if (hiddenForm[0] !== '' || hiddenForm[1] !== '' || hiddenForm[2] !== 'correct horse') throw new Error('The fill went into a hidden password field.')

    // A page that reveals the field before the password goes in gets nothing.
    await browser.navigate(`${origin}/reveal-early`)
    await until('the page', () => !page().isLoading())
    const early = await browser.findSavedLogin()
    const earlyRefusal = await browser.fillSavedLogin({ tabId: early.tabId, pageId: early.pageId, origin: early.origin, loginId: early.login!.id })
      .then(() => undefined, (error: unknown) => (error as Error).message)
    if (earlyRefusal === undefined || await page().executeJavaScript(`document.querySelector('#pass').value`) !== '') {
      throw new Error('A field revealed before the fill took the password.')
    }

    // A page echoing the password into its text, console and a GET address: the agent reads it blanked.
    await browser.navigate(`${origin}/echo`)
    await until('the page', () => !page().isLoading())
    const echo = await browser.findSavedLogin()
    await browser.fillSavedLogin({ tabId: echo.tabId, pageId: echo.pageId, origin: echo.origin, loginId: echo.login!.id })
    // BrowserManager passes page output through this redaction; the tab refuses screenshots of a page holding a password.
    const echoedPage = autofill.redact(await browser.snapshot())
    if (!echoedPage.visibleText.includes('••••••••')) throw new Error('The page did not echo the password, so this check proves nothing.')
    const refusedShot = await browser.screenshot().then(() => undefined, (error: unknown) => (error as Error).message)
    if (refusedShot?.includes('received a saved password') !== true) throw new Error('A page holding the password was captured in a screenshot.')
    await browser.click('#go')
    await until('the GET address', () => page().getURL().includes('/echoed') && !page().isLoading())
    const echoedTabs = autofill.redact(browser.state())
    const afterGet = await browser.screenshot().then(() => undefined, (error: unknown) => (error as Error).message)
    if (afterGet?.includes('received a saved password') !== true) throw new Error('A page whose address carries the password was captured.')
    await browser.navigate(`${origin}/done`)
    await browser.screenshot()
    if (/correct|horse/.test(JSON.stringify([echoedPage, echoedTabs]))) {
      throw new Error(`An agent read an echoed password: ${JSON.stringify([echoedPage.visibleText, echoedPage.console])}`)
    }

    // A username-only step has no password field for an agent fill.
    await browser.navigate(`${origin}/username-step`)
    await until('the page', () => !page().isLoading())
    if ((await browser.findSavedLogin()).passwordField) throw new Error('A username-only step reported a password field.')

    // The page moved to another origin while the card waited: refused, nothing filled.
    await browser.navigate(`${origin}/login`)
    await until('the page', () => !page().isLoading())
    const before = await browser.findSavedLogin()
    await browser.navigate(`${otherOrigin}/login`)
    await until('the other page', () => !page().isLoading())
    const moved = await browser.fillSavedLogin({ tabId: before.tabId, pageId: before.pageId, origin: before.origin, loginId: before.login!.id })
      .then(() => undefined, (error: unknown) => (error as Error).message)
    if (moved !== `The page moved from 127.0.0.1:${address.port} to localhost:${address.port} before Fill was clicked, so nothing was filled.`) {
      throw new Error(`The moved page was not refused as expected: ${moved}`)
    }
    if (await page().executeJavaScript(`document.querySelector('#pass').value`) !== '') throw new Error('A moved page was filled.')

    // A secret card's value: it lands in the field, the page and whatever it leads to stay
    // sealed with no copy held, and only an address someone picks lifts that.
    const cardValue = 'card-value-sentinel'
    await browser.navigate(`${origin}/echo`)
    await until('the page', () => !page().isLoading())
    const field = await browser.findPasswordField()
    if (!field.passwordField || field.origin !== origin) throw new Error(`Unexpected secret field ${JSON.stringify(field)}`)
    await browser.fillSecret({ tabId: field.tabId, pageId: field.pageId, origin: field.origin, value: cardValue })
    if (await page().executeJavaScript(`document.querySelector('#pass').value`) !== cardValue) throw new Error('The secret did not land.')
    if (autofill.redact(cardValue) !== cardValue) throw new Error('Manor kept a copy of the secret.')
    const refusal = (read: Promise<unknown>) => read.then(() => undefined, (error: unknown) => (error as Error).message)
    if ((await refusal(browser.snapshot()))?.includes('received a secret') !== true) throw new Error('A sealed page was read.')
    if ((await refusal(browser.screenshot()))?.includes('received a secret') !== true) throw new Error('A sealed page was captured.')
    const clicked = await browser.click('#go')
    await until('the secret GET address', () => page().getURL().includes('/echoed') && !page().isLoading())
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    if ((await refusal(browser.snapshot()))?.includes('received a secret') !== true) throw new Error('The page a secret led to was read.')
    if (active().passwords?.offer !== undefined) throw new Error('A secret card value offered to save or update a login.')
    if (JSON.stringify([clicked, browser.state(), store.list()]).includes(cardValue)) throw new Error('The secret left the sealed page.')
    await browser.navigate(`${origin}/done`)
    await until('the page', () => !page().isLoading())
    if (!(await browser.snapshot()).url.endsWith('/done')) throw new Error('A new address did not lift the seal.')
    if (active().canGoBack) throw new Error('Back still reaches the page that took the secret.')

    // The page changed while the card waited: same origin or not, nothing fills.
    await browser.navigate(`${origin}/login`)
    await until('the page', () => !page().isLoading())
    const stale = await browser.findPasswordField()
    await browser.navigate(`${origin}/required`)
    await until('the next page', () => !page().isLoading())
    const movedSecret = await refusal(browser.fillSecret({ tabId: stale.tabId, pageId: stale.pageId, origin: stale.origin, value: cardValue }))
    if (movedSecret === undefined || await page().executeJavaScript(`document.querySelector('#pass').value`) !== '') {
      throw new Error('A changed page took the secret.')
    }

    // A sign-in popup carries the same guest script.
    await browser.navigate(`${origin}/login`)
    await browser.click('#popup')
    await until('the sign-in popup', () => active().signIn !== undefined)
    const popup = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/popup-login'))
    if (popup === undefined || active().passwords?.logins.length !== 1) throw new Error('The sign-in popup has no saved logins.')
    await until('the popup page', () => !popup.isLoading())
    browser.fillPassword(saved[0].id)
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    if (await popup.executeJavaScript(`document.querySelector('#pass').value`) !== 'correct horse') {
      throw new Error('The sign-in popup did not run the guest script.')
    }
    console.log(JSON.stringify({ capture: true, offer: true, saveOnAnswer: true, fill: true, pageHeardFill: true, unrelatedButtonIgnored: true, blockedSubmitIgnored: true, associatedControls: true, usernameStepFill: true, otherOriginRefused: true, agentFill: true, agentRevealCleared: true, agentHiddenFieldSkipped: true, agentEarlyRevealRefused: true, agentEchoRedacted: true, agentUsernameStep: true, agentMovedOriginRefused: true, popupLogins: true }))
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
