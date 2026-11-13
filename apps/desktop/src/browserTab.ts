import { webContents, type Session, type WebContents } from 'electron'
import type { BrowserPageView } from './browserWebviews'
import { attachContextMenu } from './browserContextMenu'
import { noPagePasswords, type AgentLoginLookup, type PagePasswords } from './browserPasswordAutofill'
import { noPageAdblock, type PageAdblock } from './browserAdblock'
import { randomUUID } from 'node:crypto'
import { setBrowserInputScale, stopBrowserInput, withBrowserLayout, withBrowserInput } from './browserInputAction'
import { withBrowserPainting } from './browserPainting'
import type {
  BrowserFindResult,
  BrowserPageSettings,
  BrowserConsoleEntry,
  BrowserInteractiveElement,
  BrowserSnapshot,
  BrowserScreenshot,
  BrowserTabState,
  BrowserViewportBounds,
  PageContextAttachment,
} from '@manor/contracts'
import {
  normalizeBrowserKey,
  normalizeWebsiteUrl,
  parseScrollDelta,
  parseBrowserSettings,
  persistableUrl,
  readPageContextAttachment,
  withTimeout,
} from './browserValues'

/** Where a site's mark outlives its page: a reloaded tab and a history suggestion. */
export interface PageMarks {
  record(url: string, favicon: string): void
  lookup(url: string): string | undefined
}

const noPageMarks: PageMarks = { record: () => {}, lookup: () => undefined }

const MAX_CONSOLE_ITEMS = 30
const NAVIGATION_TIMEOUT_MS = 20_000
/** Chromium's user-activation lifespan: input this recent may still open a popup. */
const POPUP_ACTIVATION_MS = 5_000
const ACTIVATING_INPUT = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'touchEnd'])

/** Recent input in one page, spent by the first popup it opens, as Chromium's blocker does. */
class UserActivation {
  private at = 0
  constructor(contents: WebContents) {
    contents.on('input-event', (_event, input) => {
      if (ACTIVATING_INPUT.has(input.type)) this.at = Date.now()
    })
    // Input belongs to the document it landed on; the next page cannot spend it.
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.at = 0
    })
  }
  take(): boolean {
    const active = Date.now() - this.at < POPUP_ACTIVATION_MS
    this.at = 0
    return active
  }
}

// Covered pages may not paint. Flush their layout on a timer rather than holding
// the input queue until the menu closes or a screencast happens to wake rendering.
const SETTLE_VIEWPORT_EXPRESSION = `new Promise(resolve => {
  const finish = () => { document.documentElement?.getBoundingClientRect(); resolve() }
  const timer = setTimeout(finish, 100)
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); finish() }))
})`

/**
 * A favicon is a 16px mark. Anything past this is not one, and every byte of it
 * would ride to the renderer inside a tab-strip message on every state change.
 */
const MAX_FAVICON_BYTES = 48 * 1024
const FAVICON_TIMEOUT_MS = 5_000

const SNAPSHOT_EXPRESSION = `(() => {
  const selectorFor = (element) => {
    if (element.id) return '#' + CSS.escape(element.id)
    const testId = element.getAttribute('data-testid')
    if (testId) return '[data-testid="' + CSS.escape(testId) + '"]'
    const parts = []
    let current = element
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.tagName.toLowerCase()
      const parent = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      }
      parts.unshift(part)
      current = parent
    }
    return parts.join(' > ')
  }

  const visible = (element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }

  const candidates = Array.from(document.querySelectorAll(
    'a[href],button,input,textarea,select,[role="button"],[role="link"],[tabindex]'
  )).filter(visible).slice(0, 200)

  return {
    focusedSelector: document.activeElement instanceof Element ? selectorFor(document.activeElement) : null,
    visibleText: (document.body?.innerText ?? '').slice(0, 20000),
    interactiveElements: candidates.map((element) => {
      const rect = element.getBoundingClientRect()
      const text = (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 240)
      const role = element.getAttribute('role') || undefined
      const label = element.getAttribute('aria-label') || element.getAttribute('alt') || undefined
      const type = element.getAttribute('type') || undefined
      return {
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        ...(role ? { role } : {}),
        ...(label ? { label } : {}),
        ...(text ? { text } : {}),
        ...(type ? { type } : {}),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    }),
  }
})()`

const SEALED_PAGE = 'This page received a secret, so agents cannot read it, nor any page it leads to. Go to a new address with browser_navigate to read again.'
const SEALED_CONTEXT = 'This page received a secret, so it cannot go into a chat. Go to a new address first.'
const HELD_SCREENSHOT = 'This page received a saved password, so Manor takes no screenshot of it until it loads another page. Use browser_snapshot.'

const PAGE_CONTEXT_CANCEL_EXPRESSION = `globalThis.__manorCancelPageContext?.()`

/**
 * Runs inside the inspected page. The overlay belongs to the page rather than the
 * Manor renderer because a native BrowserPageView is painted above React and cannot
 * be targeted by a DOM layer in the app shell.
 */
const PAGE_CONTEXT_SELECTION_EXPRESSION = `(() => new Promise((resolve) => {
  globalThis.__manorCancelPageContext?.()

  let settled = false
  let hovered = null
  const overlay = document.createElement('div')
  overlay.setAttribute('data-manor-page-context-overlay', '')
  Object.assign(overlay.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483647',
    border: '2px solid #4f7cff',
    borderRadius: '4px',
    background: 'rgba(79,124,255,0.08)',
    boxSizing: 'border-box',
    display: 'none',
  })
  document.documentElement.appendChild(overlay)

  const selectorFor = (element) => {
    if (!(element instanceof Element)) return undefined
    if (element.id) return '#' + CSS.escape(element.id)
    const testId = element.getAttribute('data-testid')
    if (testId) return '[data-testid="' + CSS.escape(testId) + '"]'
    const parts = []
    let current = element
    while (current && current !== document.documentElement && parts.length < 8) {
      let part = current.tagName.toLowerCase()
      const parent = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      }
      parts.unshift(part)
      current = parent
    }
    return parts.join(' > ') || undefined
  }

  const cleanHtml = (html) => {
    const template = document.createElement('template')
    template.innerHTML = html
    template.content.querySelectorAll('script,style,noscript,template').forEach((node) => node.remove())
    template.content.querySelectorAll('*').forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name)
      }
    })
    return template.innerHTML.slice(0, 8000)
  }

  const elementResult = (element) => {
    const text = (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 6000)
    const label = (
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.getAttribute('alt') ||
      text ||
      element.tagName.toLowerCase()
    ).slice(0, 240)
    return {
      kind: 'element',
      url: location.href,
      title: document.title.slice(0, 500),
      label,
      text,
      html: cleanHtml(element.outerHTML),
      selector: selectorFor(element),
    }
  }

  const textResult = (selection) => {
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    if (range === null) return null
    const holder = document.createElement('div')
    holder.appendChild(range.cloneContents())
    const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
    const text = selection.toString().trim().replace(/\\s+/g, ' ').slice(0, 6000)
    if (text === '') return null
    return {
      kind: 'text',
      url: location.href,
      title: document.title.slice(0, 500),
      label: text.slice(0, 240),
      text,
      html: cleanHtml(holder.innerHTML),
      selector: selectorFor(container),
    }
  }

  const cleanup = () => {
    document.removeEventListener('pointermove', move, true)
    document.removeEventListener('click', click, true)
    document.removeEventListener('mouseup', mouseup, true)
    document.removeEventListener('keydown', keydown, true)
    overlay.remove()
    if (globalThis.__manorCancelPageContext === cancel) delete globalThis.__manorCancelPageContext
  }
  const finish = (result) => {
    if (settled) return
    settled = true
    cleanup()
    resolve(result)
  }
  const cancel = () => finish(null)
  const move = (event) => {
    const target = event.target
    if (!(target instanceof Element) || target === overlay) return
    hovered = target
    const rect = target.getBoundingClientRect()
    Object.assign(overlay.style, {
      display: rect.width > 0 && rect.height > 0 ? 'block' : 'none',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    })
  }
  const suppressClick = (event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const mouseup = (event) => {
    const selection = getSelection()
    if (selection === null || selection.isCollapsed) return
    const result = textResult(selection)
    if (result === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    document.addEventListener('click', suppressClick, { capture: true, once: true })
    setTimeout(() => document.removeEventListener('click', suppressClick, true), 0)
    finish(result)
  }
  const click = (event) => {
    const target = event.target instanceof Element ? event.target : hovered
    if (!(target instanceof Element) || target === overlay) return
    event.preventDefault()
    event.stopImmediatePropagation()
    finish(elementResult(target))
  }
  const keydown = (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    cancel()
  }

  globalThis.__manorCancelPageContext = cancel
  document.addEventListener('pointermove', move, true)
  document.addEventListener('click', click, true)
  document.addEventListener('mouseup', mouseup, true)
  document.addEventListener('keydown', keydown, true)
}))()`

/**
 * One page. Owns its `BrowserPageView`, its debugger session and its console buffer;
 * knows nothing about panels, chats or which window it currently hangs in. Every
 * agent action lands on exactly one of these, the active one.
 */
export class BrowserTab {
  readonly id: string
  private view: BrowserPageView | null = null
  /** The delivered page's world a running pick lives in, so Escape cancels it there. */
  private pageContextWorld: number | undefined
  private initialization: Promise<void> | null = null
  private closed = false
  private recoveries = 0
  /** The history entry the current swipe started on, and the last step a swipe took. */
  private swipeFrom = -1
  private swipeStep = { way: '', at: 0 }
  private rememberedUrl = 'about:blank'
  private rememberedTitle = ''
  private restoredUrl: string | null = null
  private presentation: 'hidden' | 'sidebar' | 'floating' = 'hidden'
  private readonly consoleEntries: BrowserConsoleEntry[] = []
  private settings: BrowserPageSettings = { viewport: null, appearance: 'system', zoomFactor: 1 }
  private availableBounds: BrowserViewportBounds | null = null
  private loading = false
  private favicon: string | undefined
  private faviconSource: string | undefined
  private faviconRequest = 0
  /** The sign-in popup this page opened, drawn over it; it lives and dies with the tab. */
  private popup: { contents: WebContents; url: string; loading: boolean } | null = null

  constructor(
    id: string,
    private readonly browserSession: Session,
    /** Told when anything a tab strip renders has changed. */
    private readonly onChanged: () => void,
    /** A `target="_blank"` link is a new tab, not a page that replaces this one. */
    private readonly onPopup: (url: string) => void,
    private readonly createView: (id: string) => Promise<BrowserPageView>,
    private readonly onVisit: (url: string, title: string) => void = () => {},
    private readonly onTitle: (url: string, title: string) => void = () => {},
    private readonly marks: PageMarks = noPageMarks,
    private readonly passwords: PagePasswords = noPagePasswords,
    private readonly adblock: PageAdblock = noPageAdblock,
  ) {
    this.id = id
  }

  state(): BrowserTabState {
    const contents = this.view?.webContents
    const shown = contents === undefined ? undefined : this.shown(contents)
    const url = this.restoredUrl ?? shown?.url ?? this.rememberedUrl
    const favicon = this.favicon ?? this.marks.lookup(url)
    // A sign-in popup is where the login form is, so its site decides the saved logins.
    const popupUrl = this.popup === null ? undefined : this.shownUrl(this.popup.contents, this.popup.url)
    const passwords = this.passwords.state(this.id, popupUrl ?? url)
    // Blocking is switched for the page on screen, which is the sign-in popup while it is open.
    const adblock = this.popup === null ? this.adblock.state(contents, url) : this.adblock.state(this.popup.contents, popupUrl ?? url)
    return {
      id: this.id,
      settings: { ...this.settings, zoomFactor: this.visibleContents()?.getZoomFactor() ?? this.settings.zoomFactor },
      title: shown?.title ?? this.rememberedTitle,
      url,
      loading: this.loading,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      ...(favicon === undefined ? {} : { favicon }),
      ...(this.popup === null ? {} : { signIn: { url: popupUrl ?? url, ...(this.popup.loading ? { loading: true } : {}) } }),
      ...(passwords === undefined ? {} : { passwords }),
      ...(adblock === undefined ? {} : { adblock }),
    }
  }

  /** Fills the open sign-in popup, else the page; the autofill re-checks its site. */
  fillPassword(loginId: string): void {
    this.passwords.fill(this.loginContents(), loginId)
  }

  /** An agent's fill request reads and fills the same page the user's key would. */
  findSavedLogin(username?: string): Promise<AgentLoginLookup> {
    return this.passwords.agentLookup(this.loginContents(), username)
  }

  fillSavedLogin(target: { pageId: number; origin: string; loginId: string }): Promise<{ username: string }> {
    return this.passwords.agentFill(this.loginContents(), target)
  }

  findPasswordField(): Promise<AgentLoginLookup> {
    return this.passwords.agentField(this.loginContents())
  }

  fillSecret(target: { pageId: number; origin: string; value: string }): Promise<void> {
    // A sign-in popup can write to its opener, so a value in the popup can cross into the page.
    const opener = this.popup === null ? undefined : this.view?.webContents
    return this.passwords.agentFillSecret(this.loginContents(), target, opener)
  }

  /** The address and title that may leave this tab: a sealed page's could carry its secret. */
  private shown(contents: WebContents): { url: string; title: string } {
    return { url: this.shownUrl(contents, contents.getURL()), title: this.passwords.sealed(contents) ? '' : contents.getTitle() }
  }

  private shownUrl(contents: WebContents, url: string): string {
    return this.passwords.sealedOrigin(contents) ?? url
  }

  private loginContents(): WebContents {
    const contents = this.popup?.contents ?? this.view?.webContents
    if (contents === undefined) throw new Error('This browser tab has no page to fill.')
    return contents
  }

  /** Whether the page is making sound, which keeps it alive while nobody looks at it. */
  audible(): boolean {
    return this.view?.webContents.isCurrentlyAudible() === true
  }

  /**
   * Drops the live page but keeps the tab: its address, title and mark. The next use
   * reloads it, the way Chrome brings back a tab it discarded. Back and forward do not
   * survive: a guest has always loaded its placeholder first, and Electron refuses to
   * restore history into one that has. A page still loading is not idle and stays.
   */
  discard(): boolean {
    const view = this.view
    if (this.closed || view === null || this.loading || this.popup !== null) return false
    const contents = view.webContents
    // A one-time callback on screen comes back blank rather than replayed.
    const shown = this.shown(contents)
    this.rememberedUrl = persistableUrl(shown.url)
    this.rememberedTitle = shown.title
    this.view = null
    this.initialization = null
    this.availableBounds = null
    this.consoleEntries.length = 0
    void stopBrowserInput(contents)
    if (contents.debugger.isAttached()) contents.debugger.detach()
    view.close()
    this.onChanged()
    return true
  }

  /** What the user sees of this tab: its sign-in popup while open, else its page. */
  visibleContents(): WebContents | undefined {
    const popup = this.popup?.contents
    if (popup !== undefined && !popup.isDestroyed()) return popup
    return this.view?.webContents
  }

  /** Null until the page exists, which is what keeps a tab lazy. */
  peek(): BrowserPageView | null {
    return this.view
  }

  /** A restored tab keeps its URL without creating a page until it is selected. */
  restoreUrl(url: string): void {
    this.restoredUrl = url === '' ? 'about:blank' : url
  }

  async loadRestoredUrl(): Promise<void> {
    const url = this.restoredUrl
    if (url === null) return
    if (url === 'about:blank') this.restoredUrl = null
    else await this.navigate(url)
  }

  async setBounds(bounds: BrowserViewportBounds, presentation: 'hidden' | 'sidebar' | 'floating' = 'hidden'): Promise<void> {
    const view = await this.ensureView()
    if (this.presentation === presentation && this.availableBounds !== null && Object.keys(bounds).every((key) =>
      bounds[key as keyof BrowserViewportBounds] === this.availableBounds?.[key as keyof BrowserViewportBounds])) return
    await withBrowserLayout(view.webContents, async () => {
      this.availableBounds = bounds
      this.presentation = presentation
      await this.applyViewport(view)
    })
  }

  async configure(raw: unknown): Promise<void> {
    const patch = parseBrowserSettings(raw)
    // Zoom is for the page on screen, so an open sign-in popup takes it and the tab keeps its own.
    const popup = this.popup?.contents
    if (patch.zoomFactor !== undefined && popup !== undefined && !popup.isDestroyed()) {
      popup.setZoomFactor(patch.zoomFactor)
      delete patch.zoomFactor
      this.onChanged()
      if (Object.keys(patch).length === 0) return
    }
    const view = await this.ensureView()
    await this.cancelPageContextSelection()
    await withBrowserLayout(view.webContents, async () => {
      const next = { ...this.settings, ...patch }
      if (patch.appearance !== undefined) {
        await view.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: next.appearance === 'system' ? [] : [{ name: 'prefers-color-scheme', value: next.appearance }],
        })
      }
      if (patch.zoomFactor !== undefined) view.webContents.setZoomFactor(next.zoomFactor)
      this.settings = next
      await this.applyViewport(view)
      // Native emulation and zoom reach Chromium asynchronously. Let its layout
      // commit before releasing the next agent's target measurement.
      await withBrowserPainting(view.webContents, () => view.webContents.executeJavaScript(SETTLE_VIEWPORT_EXPRESSION))
    })
    this.onChanged()
  }

  /** Fit the complete CSS viewport into the native slot; never stretch the site. */
  private async applyViewport(view: BrowserPageView): Promise<void> {
    const bounds = this.availableBounds ?? view.getBounds()
    const viewport = this.settings.viewport ?? (this.presentation === 'floating' ? { width: 1280, height: 720 } : null)
    if (viewport === null) {
      setBrowserInputScale(view.webContents, 1)
      view.webContents.disableDeviceEmulation()
      await view.present(bounds, this.presentation, true)
      return
    }
    const scale = Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height)
    setBrowserInputScale(view.webContents, scale)
    const width = Math.max(1, Math.round(viewport.width * scale))
    const height = Math.max(1, Math.round(viewport.height * scale))
    await view.present({ x: bounds.x + Math.floor((bounds.width - width) / 2), y: bounds.y + Math.floor((bounds.height - height) / 2), width, height }, this.presentation)
    view.webContents.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: viewport, viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0, viewSize: viewport, scale,
    })
  }

  async hardReload(): Promise<void> {
    const contents = (await this.ensureView()).webContents
    await this.cancelPageContextSelection()
    await withBrowserLayout(contents, () => { contents.reloadIgnoringCache() })
  }

  async openDevTools(): Promise<void> {
    const contents = (await this.ensureView()).webContents
    await stopBrowserInput(contents)
    contents.openDevTools({ mode: 'detach' })
  }

  async navigate(raw: string): Promise<{ url: string; title: string }> {
    const url = normalizeWebsiteUrl(raw)
    const view = await this.ensureView()
    this.consoleEntries.length = 0
    // Gone first: a popup holding the value could otherwise write into the page it opened.
    if (this.passwords.sealed(view.webContents)) await this.closeSignIn()
    await withBrowserInput(view.webContents, (input) => navigateWithCdp(view.webContents, url, input.signal))
    this.restoredUrl = null
    if (this.passwords.sealed(view.webContents)) this.unseal(view.webContents)
    return { url: view.webContents.getURL(), title: view.webContents.getTitle() }
  }

  /** Back must not return to the page that took the secret. The commit itself went unrecorded while sealed. */
  private unseal(contents: WebContents): void {
    contents.navigationHistory.clear()
    this.consoleEntries.length = 0
    this.passwords.unseal(contents)
    this.rememberedUrl = contents.getURL()
    this.rememberedTitle = contents.getTitle()
    this.onVisit(this.rememberedUrl, this.rememberedTitle)
    this.onChanged()
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const contents = (await this.ensureView()).webContents
    if (this.passwords.sealed(contents)) throw new Error(SEALED_PAGE)
    const page = await contents.debugger.sendCommand('Runtime.evaluate', {
      expression: SNAPSHOT_EXPRESSION,
      returnByValue: true,
    })
    const document = readDocumentSnapshot(asRecord(asRecord(page)?.result)?.value)
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      visibleText: document.visibleText,
      focusedSelector: document.focusedSelector,
      interactiveElements: document.interactiveElements,
      console: [...this.consoleEntries],
    }
  }

  async click(rawSelector: string): Promise<{ url: string; title: string; selector: string }> {
    const selector = checkedSelector(rawSelector)
    const contents = (await this.ensureView()).webContents
    return withBrowserInput(contents, async (input) => {
      const point = asRecord(await input.evaluate(`(() => {
        const matches = document.querySelectorAll(${JSON.stringify(selector)})
        if (matches.length !== 1) return null
        const element = matches[0]
        if (!(element instanceof HTMLElement) || element.matches(':disabled') ||
          element.closest('[inert],[aria-disabled="true"]')) return null
        const style = getComputedStyle(element)
        if (style.visibility !== 'visible' || style.display === 'none') return null
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        const rect = element.getBoundingClientRect()
        const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right)
        const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom)
        if (right <= left || bottom <= top) return null
        const x = (left + right) / 2, y = (top + bottom) / 2
        const hit = document.elementFromPoint(x, y)
        if (hit !== element && !element.contains(hit)) return null
        return { x, y }
      })()`))
      if (typeof point?.x !== 'number' || typeof point.y !== 'number' ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new Error(`No unique, visible, enabled and unobstructed browser element matches ${selector}.`)
      }
      const target = { x: point.x, y: point.y }
      await input.showCursor('move', target)
      const navigation = watchPossibleNavigation(contents)
      try {
        try {
          await input.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
          })
        } finally {
          // A cancelled press must release outside the page so it cannot complete a click.
          await input.dispatch('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: input.interrupted ? -1 : point.x,
            y: input.interrupted ? -1 : point.y, button: 'left', clickCount: 1,
          })
        }
        await input.showCursor('click', target)
        await input.wait(navigation.done)
        return { ...this.shown(contents), selector }
      } finally {
        navigation.cancel()
      }
    })
  }

  async type(rawSelector: string, text: string): Promise<{ selector: string }> {
    const selector = checkedSelector(rawSelector)
    if (text.length > 20_000) throw new Error('Browser text is too long.')
    const contents = (await this.ensureView()).webContents
    return withBrowserInput(contents, async (input) => {
      const focused = await input.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)})
        if (!(element instanceof HTMLElement)) return false
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        const textControl = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        if ((!textControl && !element.isContentEditable) || element.matches(':disabled,[readonly]')) return false
        element.focus()
        if (document.activeElement !== element) return false
        if (textControl) element.select()
        else {
          const range = document.createRange()
          range.selectNodeContents(element)
          const selection = getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
        // Native insertText can silently drop input before a guest receives mouse focus.
        if (!document.execCommand(${text.length ? "'insertText'" : "'delete'"}, false, ${JSON.stringify(text)})) return false
        element.dispatchEvent(new Event('change', { bubbles: true }))
        const rect = element.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })()`)
      const point = asRecord(focused)
      if (typeof point?.x !== 'number' || typeof point.y !== 'number') {
        throw new Error(`No editable browser element matches ${selector}.`)
      }
      await input.showCursor('move', { x: point.x, y: point.y })
      return { selector }
    })
  }

  async press(rawKey: string): Promise<{ key: string }> {
    const key = normalizeBrowserKey(rawKey)
    const view = await this.ensureView()
    const contents = view.webContents
    return withBrowserInput(contents, async (input) => {
      const previous = webContents.getFocusedWebContents()
      const releaseFocus = await view.focusForKeyboard()
      const navigation = watchPossibleNavigation(contents)
      try {
        contents.focus()
        await input.send('Page.bringToFront')
        await input.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        try {
          await input.send('Input.dispatchKeyEvent', { type: key.key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...key,
            ...(key.key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
        } finally {
          await input.dispatch('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
        }
        await input.wait(navigation.done)
        return { key: key.key }
      } finally {
        navigation.cancel()
        await input.dispatch('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
        if (previous && previous !== contents && !previous.isDestroyed()) previous.focus()
        await releaseFocus()
      }
    })
  }

  async scroll(rawX: unknown, rawY: unknown): Promise<{ deltaX: number; deltaY: number }> {
    const delta = parseScrollDelta(rawX, rawY)
    const contents = (await this.ensureView()).webContents
    return withBrowserInput(contents, async (input) => {
      await input.evaluate(`window.scrollBy({ left: ${delta.deltaX}, top: ${delta.deltaY}, behavior: 'instant' })`)
      return delta
    })
  }

  /** Pixels cannot be redacted, so a page holding a filled password is not captured until it loads another page. */
  async screenshot(): Promise<BrowserScreenshot> {
    const contents = (await this.ensureView()).webContents
    if (this.passwords.sealed(contents)) throw new Error(SEALED_PAGE)
    if (this.passwords.holds(contents)) throw new Error(HELD_SCREENSHOT)
    const fills = this.passwords.fillsInto(contents)
    const capture = await withBrowserPainting(contents, () => withTimeout(contents.capturePage(undefined, { stayHidden: true, stayAwake: true }), 2500))
    if (capture.isEmpty()) throw new Error('Chromium returned no browser screenshot.')
    // The user's own key may have filled the page while it was being captured.
    if (this.passwords.fillsInto(contents) !== fills) throw new Error(HELD_SCREENSHOT)
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      screenshot: capture.toDataURL(),
    }
  }

  async selectPageContext(): Promise<PageContextAttachment | null> {
    const contents = (await this.ensureView()).webContents
    if (this.passwords.sealed(contents)) throw new Error(SEALED_CONTEXT)
    const page = await deliveredPageWorld(contents)
    this.pageContextWorld = page
    try {
      const raw = await evaluateValue(contents, PAGE_CONTEXT_SELECTION_EXPRESSION, page)
      // A selection stays open while the page moves on, so a secret can land during it.
      if (raw === null || this.passwords.sealed(contents)) return null
      // The delivered page itself sits at about:srcdoc; the context names the address the user opened.
      const value = page === undefined ? raw : { ...asRecord(raw), url: contents.getURL(), title: contents.getTitle() }
      return readPageContextAttachment(value, `page_${randomUUID()}`)
    } finally {
      if (this.pageContextWorld === page) this.pageContextWorld = undefined
    }
  }

  async cancelPageContextSelection(): Promise<void> {
    const contents = this.view?.webContents
    if (contents === undefined || !contents.debugger.isAttached()) return
    await evaluateValue(contents, PAGE_CONTEXT_CANCEL_EXPRESSION, this.pageContextWorld).catch(() => undefined)
  }

  goBack(): void {
    const history = this.view?.webContents.navigationHistory
    if (history?.canGoBack() === true) history.goBack()
  }

  goForward(): void {
    const history = this.view?.webContents.navigationHistory
    if (history?.canGoForward() === true) history.goForward()
  }

  reload(): void {
    this.view?.webContents.reload()
  }

  /** Switches blocking for the page on screen, the sign-in popup included, and reloads it. */
  setSiteAdblock(blocking: boolean): void {
    const popup = this.popup
    const target = popup !== null && !popup.contents.isDestroyed() ? { contents: popup.contents, url: this.shownUrl(popup.contents, popup.url) } : undefined
    this.adblock.setSiteBlocking(target?.url ?? this.state().url, blocking)
    if (target === undefined) this.reload()
    else target.contents.reload()
  }

  stopLoading(): void {
    this.view?.webContents.stop()
  }

  /** Find on page; resolves with Chromium's final count for this request, or no matches after a second. */
  find(query: string, forward: boolean, next: boolean): Promise<BrowserFindResult> {
    if (typeof query !== 'string' || query === '' || query.length > 1000) throw new Error('Type something to find on the page.')
    const contents = this.visibleContents()
    if (contents === undefined || contents.isDestroyed()) return Promise.resolve({ matches: 0, active: 0 })
    return new Promise((resolve) => {
      let last: BrowserFindResult = { matches: 0, active: 0 }
      const finish = () => {
        clearTimeout(timer)
        if (!contents.isDestroyed()) contents.off('found-in-page', found)
        resolve(last)
      }
      const found = (_event: Electron.Event, result: Electron.Result) => {
        if (result.requestId !== requestId) return
        last = { matches: result.matches, active: result.activeMatchOrdinal }
        if (result.finalUpdate) finish()
      }
      const timer = setTimeout(finish, 1_000)
      contents.on('found-in-page', found)
      // `findNext: true` starts a new search in Electron's terms; a step keeps the current one.
      const requestId = contents.findInPage(query, { forward, findNext: !next })
    })
  }

  stopFind(): void {
    for (const contents of [this.popup?.contents, this.view?.webContents]) {
      if (contents !== undefined && !contents.isDestroyed()) contents.stopFindInPage('keepSelection')
    }
  }

  async endAgentUse(): Promise<void> {
    if (this.view !== null) await stopBrowserInput(this.view.webContents)
  }

  close(): void {
    this.closed = true
    this.passwords.forget(this.id)
    const view = this.view
    this.view = null
    this.initialization = null
    this.consoleEntries.length = 0
    this.cancelSignIn()
    if (view === null) return
    void stopBrowserInput(view.webContents)
    void evaluateValue(view.webContents, PAGE_CONTEXT_CANCEL_EXPRESSION).catch(() => undefined)
    if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach()
    view.close()
  }

  /** Closes the sign-in popup and shows the page again. Its beforeunload cannot refuse. */
  cancelSignIn(): void {
    const contents = this.popup?.contents
    if (contents !== undefined && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
  }

  private closeSignIn(): Promise<void> {
    const contents = this.popup?.contents
    if (contents === undefined || contents.isDestroyed()) return Promise.resolve()
    return new Promise((resolve) => {
      contents.once('destroyed', () => resolve())
      this.cancelSignIn()
    })
  }

  /**
   * The popup is drawn inside this tab's page area rather than as a macOS window, so
   * it hides with the tab, survives fullscreen and never leaves Manor. The page keeps
   * a real handle to it for the opener handshake. A second popup replaces the first.
   */
  private hostPopup(view: BrowserPageView, contents: WebContents, url: string): WebContents {
    this.cancelSignIn()
    const popup = { contents, url, loading: false }
    this.popup = popup
    const activation = new UserActivation(contents)
    this.passwords.watch(this.id, contents, this.onChanged)
    this.adblock.watch(contents, this.onChanged)
    contents.setWindowOpenHandler(({ url: next }) => this.passwords.sealed(contents) ? { action: 'deny' } : this.openAsTab(next, activation))
    const moved = (_event: unknown, next: string) => { popup.url = next; this.onChanged() }
    contents.on('did-navigate', moved)
    contents.on('did-navigate-in-page', (event, next, isMainFrame) => { if (isMainFrame) moved(event, next) })
    // Find searches the popup while it is open, so its loads are published like the page's.
    const loading = (value: boolean) => () => { popup.loading = value; if (this.popup === popup) this.onChanged() }
    contents.on('did-start-loading', loading(true))
    contents.on('did-stop-loading', loading(false))
    // A crashed sign-in page cannot close itself; Manor drops it so the page shows again.
    contents.once('render-process-gone', () => { if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }) })
    contents.once('destroyed', () => {
      if (this.popup !== popup) return
      this.popup = null
      if (!this.closed) this.onChanged()
    })
    view.overlay(contents)
    this.onChanged()
    return contents
  }

  /** A new tab when input asked for it, blocked otherwise; never a window handle. */
  private openAsTab(url: string, activation: UserActivation): { action: 'deny' } {
    if (activation.take()) this.onPopup(url)
    return { action: 'deny' }
  }

  async ensureView(): Promise<BrowserPageView> {
    if (this.closed) throw new Error('This browser tab is closed.')
    if (this.recoveries > 2) throw new Error('This browser page repeatedly crashed. Close the tab and reopen it.')
    this.initialization ??= this.createAndInitialize().catch((error) => {
      this.initialization = null
      throw error
    })
    await this.initialization
    if (!this.view) throw new Error('The browser guest was closed during initialization.')
    return this.view
  }

  private async createAndInitialize(): Promise<void> {
    const view = await this.createView(this.id)
    if (this.closed) { view.close(); throw new Error('This browser tab is closed.') }
    this.view = view
    const activation = new UserActivation(view.webContents)
    this.passwords.watch(this.id, view.webContents, this.onChanged)
    this.adblock.watch(view.webContents, this.onChanged)
    view.webContents.once('destroyed', () => {
      this.cancelSignIn()
      if (this.view !== view) return
      this.view = null
      this.initialization = null
      this.availableBounds = null
      if (!this.closed) this.onChanged()
    })
    view.webContents.once('render-process-gone', (_event, details) => {
      if (details.reason === 'crashed' || details.reason === 'oom') this.recoveries += 1
      view.close()
    })
    // A sign-in popup needs a live handle: the popup messages its opener and closes
    // itself, over this tab's session. Only a scripted popup right after input gets
    // one; a link opened by input becomes a background tab, and anything without
    // input is blocked like Chromium does.
    view.webContents.setWindowOpenHandler(({ url, disposition }) => {
      // A sealed page's new tab would carry the same content without the seal.
      if (this.passwords.sealed(view.webContents)) return { action: 'deny' }
      if (disposition !== 'new-window') return this.openAsTab(url, activation)
      if (!activation.take()) return { action: 'deny' }
      return { action: 'allow', createWindow: (options) => {
        // Electron passes the popup's page here; its typings only list window options.
        const contents = (options as { webContents?: WebContents }).webContents
        if (contents !== undefined) return this.hostPopup(view, contents, url)
        // A Shift-clicked link comes without a page: no script holds a handle, so it is
        // an ordinary link and becomes a tab. Electron ignores the return value then.
        this.onPopup(url)
        return view.webContents
      } }
    })
    attachContextMenu(view.webContents, (url) => { if (!this.passwords.sealed(view.webContents)) this.onPopup(url) })
    view.webContents.on('will-navigate', (event, url) => {
      if (url === 'about:blank') return
      try {
        normalizeWebsiteUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    // Everything a tab strip renders comes off these: the label, the address, the
    // site's own mark, and whether the arrows have anywhere to go.
    view.webContents.debugger.on('detach', () => this.onChanged())
    view.webContents.on('devtools-closed', () => {
      void this.restoreDebugger(view).catch((error: unknown) => console.warn('[manor] browser debugger restore failed', error instanceof Error ? error.message : String(error)))
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      if (this.passwords.sealed(view.webContents)) return
      this.rememberedTitle = title
      this.onTitle(view.webContents.getURL(), title)
      this.onChanged()
    })
    view.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return
      // A new page owns no part of the previous one's identity, and a mark that
      // outlived its site is the stale label rule wearing an icon.
      this.faviconRequest += 1
      this.favicon = undefined
      this.faviconSource = undefined
      this.onChanged()
    })
    view.webContents.on('did-navigate', (_event, url) => {
      // Only a committed document starts unmagnified; a cancelled navigation keeps
      // the old page, whose script still pans at its own scale.
      view.magnify?.(undefined)
      if (!this.passwords.sealed(view.webContents)) {
        this.rememberedUrl = url
        this.onVisit(url, '')
      }
      this.onChanged()
    })
    view.webContents.on('did-finish-load', () => {
      // A navigation replaces Chromium's render widget and drops native emulation.
      // Reserve its restoration before the next agent can measure the new document.
      if (this.settings.viewport === null && this.presentation !== 'floating') return
      void withBrowserLayout(view.webContents, async () => {
        await this.applyViewport(view)
        await withBrowserPainting(view.webContents, () => view.webContents.executeJavaScript(SETTLE_VIEWPORT_EXPRESSION))
      }).catch((error: unknown) => console.warn('[manor] responsive viewport restore failed', error instanceof Error ? error.message : String(error)))
    })
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame || this.passwords.sealed(view.webContents)) return
      this.rememberedUrl = url
      this.onVisit(url, view.webContents.getTitle())
      this.onChanged()
    })
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      void this.loadFavicon(favicons)
    })
    view.webContents.on('did-start-loading', () => {
      this.loading = true
      this.onChanged()
    })
    view.webContents.on('did-stop-loading', () => {
      this.loading = false
      this.onChanged()
    })

    // A fresh WebContents has no committed document yet. CDP domain activation can
    // wait forever in that state, which leaves the first navigate call stuck behind
    // initialization. Commit the inert page before attaching the debugger.
    try { await this.initializeView(view) }
    catch (error) { view.close(); throw error }
  }

  private async initializeView(view: BrowserPageView): Promise<void> {
    await view.webContents.loadURL(this.rememberedUrl)
    view.webContents.setZoomFactor(this.settings.zoomFactor)
    view.webContents.debugger.attach('1.3')
    view.webContents.debugger.on('message', (_event, method, params) => {
      this.captureDebuggerEvent(method, params)
    })
    await Promise.all([
      view.webContents.debugger.sendCommand('Page.enable'),
      view.webContents.debugger.sendCommand('Runtime.enable'),
      view.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: this.settings.appearance === 'system' ? [] : [{ name: 'prefers-color-scheme', value: this.settings.appearance }] }),
      listenForPinch(view.webContents),
    ])
  }

  private async restoreDebugger(view: BrowserPageView): Promise<void> {
    const contents = view.webContents
    if (contents.isDestroyed() || this.view !== view) return
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3')
      await Promise.all([contents.debugger.sendCommand('Page.enable'), contents.debugger.sendCommand('Runtime.enable'), listenForPinch(contents)])
      await this.configure(this.settings)
    }
    this.onChanged()
  }

  /**
   * Fetched here, in the main process, over the browser's own session — the same
   * session that just loaded the page, so the request carries nothing Manor's app
   * shell would have added and looks like what it is. Inlined as a data URL because
   * the renderer's content policy allows `data:` images and deliberately allows no
   * remote ones: pointing an `<img>` in Manor's own window at a visited site would
   * make the app shell fetch from every page the browser has ever been on.
   *
   * Every failure is silent and leaves the globe. A tab without its mark still says
   * which tab it is.
   */
  private async loadFavicon(urls: string[]): Promise<void> {
    if (this.faviconSource && urls[0] === this.faviconSource || this.isSealed()) return
    const request = ++this.faviconRequest
    for (const url of urls) {
      if (request !== this.faviconRequest || this.closed) return
      try {
        const response = await this.browserSession.fetch(url, {
          signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
        })
        if (!response.ok) continue
        const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
        if (!type.startsWith('image/')) continue
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_FAVICON_BYTES) continue
        // A navigation or newer favicon update may have replaced this request. On a
        // sealed page the bytes are page content that history would keep.
        if (request !== this.faviconRequest || this.closed || this.isSealed()) return
        this.faviconSource = url
        this.favicon = `data:${type};base64,${bytes.toString('base64')}`
        const page = this.view?.webContents.getURL()
        if (page) this.marks.record(page, this.favicon)
        this.onChanged()
        return
      } catch {
        // One broken candidate should not hide the next icon the page offered.
      }
    }
  }

  private isSealed(): boolean {
    const contents = this.view?.webContents
    return contents !== undefined && this.passwords.sealed(contents)
  }

  private pinch(raw: unknown): void {
    const params = asRecord(raw)
    if (params?.name !== PINCH_BINDING || typeof params.payload !== 'string') return
    let value: unknown
    try { value = JSON.parse(params.payload) } catch { return }
    const { scale, x, y, swipe } = asRecord(value) ?? {}
    if (swipe === 'start') { void this.answerSwipe(params.executionContextId); return }
    if (swipe === 'back' || swipe === 'forward') { this.stepSwipe(swipe); return }
    if (typeof scale !== 'number' || typeof x !== 'number' || typeof y !== 'number' ||
        !(scale >= 1 && scale <= MAX_MAGNIFICATION) || !(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) return
    this.view?.magnify?.(scale > 1 ? { scale, x, y } : undefined)
  }

  /**
   * Tells the swiping page which ways it can go, so its arrow never promises a dead end.
   * Fingers that pause past the threshold step a page while still down; moving on the
   * same way right after is the same swipe, so it gets no second step. The other way is
   * a new swipe and stays open, so a quick back then forward works.
   */
  private async answerSwipe(contextId: unknown): Promise<void> {
    const contents = this.view?.webContents
    if (typeof contextId !== 'number' || contents === undefined || !contents.debugger.isAttached()) return
    const history = contents.navigationHistory
    const recent = Date.now() - this.swipeStep.at <= SWIPE_ABANDON_MS ? this.swipeStep.way : ''
    this.swipeFrom = history.getActiveIndex()
    const back = recent !== 'back' && history.canGoBack(), forward = recent !== 'forward' && history.canGoForward()
    await contents.debugger.sendCommand('Runtime.evaluate', {
      contextId,
      expression: `globalThis.__manorSwipeHistory?.(${back}, ${forward})`,
    }).catch(() => undefined)
  }

  /** Steps only from the entry the swipe began on, so a route a site pushed mid-swipe stays. */
  private stepSwipe(way: 'back' | 'forward'): void {
    const history = this.view?.webContents.navigationHistory
    if (history === undefined || history.getActiveIndex() !== this.swipeFrom) return
    this.swipeFrom = -1
    this.swipeStep = { way, at: Date.now() }
    if (way === 'back') this.goBack()
    else this.goForward()
  }

  private captureDebuggerEvent(method: string, raw: unknown): void {
    if (method === 'Runtime.bindingCalled') { this.pinch(raw); return }
    if (method !== 'Runtime.consoleAPICalled') return
    const params = asRecord(raw)
    if (params === undefined) return
    const level = typeof params.type === 'string' ? params.type : 'log'
    // Only what a page complains about. A chatty site's own logging is not something
    // an agent reading a vacancy should pay for.
    if (level !== 'error' && level !== 'warning' && level !== 'assert') return
    const args = Array.isArray(params.args) ? params.args : []
    const text = args.map(formatRemoteValue).filter((value) => value !== '').join(' ')
    this.consoleEntries.push({
      level,
      text: text.slice(0, 500),
      timestamp: typeof params.timestamp === 'number' ? params.timestamp : Date.now(),
    })
    if (this.consoleEntries.length > MAX_CONSOLE_ITEMS) {
      this.consoleEntries.splice(0, this.consoleEntries.length - MAX_CONSOLE_ITEMS)
    }
  }
}

/**
 * A trackpad pinch over a `<webview>` reaches the page only as ctrl+wheel events;
 * Chromium applies the magnification itself to Manor's own window, where it is off.
 * The page script therefore owns the magnification like an image viewer: pinch
 * scales around the fingers, scrolling pans while magnified, and Manor's window
 * draws the guest scaled. The page never relayouts and never sees the zoom.
 */
const PINCH_WORLD = 'manor-pinch'
const PINCH_BINDING = '__manorPinch'
const MAX_MAGNIFICATION = 5
/** Wheel pixels of sideways travel before a swipe counts, about a third of a trackpad. */
const SWIPE_DISTANCE = 160
/**
 * Wheel silence that ends a swipe. Momentum arrives under 50ms apart, but a slow drag
 * pauses up to ~400ms with the fingers still down (measured on the user's trackpad), so a
 * swipe short of the threshold waits that out before the arrow gives up.
 */
const SWIPE_RELEASE_MS = 150
const SWIPE_ABANDON_MS = 450
const PINCH_SOURCE = `(() => {
  const send = globalThis.${PINCH_BINDING}
  if (typeof send !== 'function' || globalThis.__manorPinchReady) return
  globalThis.__manorPinchReady = true
  // The visible top-left as fractions of the viewport, so Manor maps it onto its own frame.
  let scale = 1, x = 0, y = 0, frame = 0
  const clamp = (value, next) => Math.min(Math.max(value, 0), 1 - 1 / next)
  const publish = () => {
    frame ||= requestAnimationFrame(() => { frame = 0; send(JSON.stringify({ scale, x, y })) })
  }
  const canScroll = (node, sideways, delta) => {
    const at = sideways ? node.scrollLeft : node.scrollTop
    return delta < 0 ? at > 0 : at + (sideways ? node.clientWidth : node.clientHeight) < (sideways ? node.scrollWidth : node.scrollHeight) - 1
  }
  // Walks the scroll chain out from the target to the first inner element that takes a
  // delta along one axis: false when an exhausted scroller contains its overscroll, null
  // when the chain reaches the document.
  const chain = (target, sideways, delta) => {
    for (let node = target; node instanceof Element && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (!/(auto|scroll)/.test(sideways ? style.overflowX : style.overflowY)) continue
      if (canScroll(node, sideways, delta)) return node
      if (/(contain|none)/.test(sideways ? style.overscrollBehaviorX : style.overscrollBehaviorY)) return false
    }
    return null
  }
  // Where scroll the magnifier cannot take goes: the chain's element, else the document.
  // A scroll-snap container snaps small steps straight back, so it is left to the page.
  const snaps = (node) => getComputedStyle(node).scrollSnapType !== 'none'
  const scroller = (target, sideways, delta) => {
    const node = chain(target, sideways, delta)
    if (node !== null) return node === false || snaps(node) ? null : node
    // The viewport takes body's overflow while html leaves its own visible, so a page
    // locked with body { overflow: hidden } stays locked; it snaps by html's style.
    const root = document.scrollingElement, html = document.documentElement, body = document.body
    const own = getComputedStyle(html)
    const overflow = own.overflowX === 'visible' && own.overflowY === 'visible' && body instanceof Element ? getComputedStyle(body) : own
    if (!(root instanceof Element) || /(hidden|clip)/.test(sideways ? overflow.overflowX : overflow.overflowY) ||
        !canScroll(root, sideways, delta) || snaps(html) || snaps(root)) return null
    return root
  }
  // Carries sub-pixel steps over until they add up to one Chromium will scroll.
  const carry = { left: 0, top: 0 }
  const scrollOn = (node, key, delta) => {
    const property = key === 'left' ? 'scrollLeft' : 'scrollTop'
    const want = node[property] + delta + carry[key]
    node.scrollTo({ [key]: want, behavior: 'instant' })
    carry[key] = Math.max(-1, Math.min(1, want - node[property]))
  }
  // Registered only while magnified: a blocking wheel listener would cost every page
  // its fast scrolling. Like Chrome's visual viewport, the magnified view pans first and
  // what is left past its edge scrolls the page, at the same on-screen speed. When
  // neither moves, the event goes to the page untouched: sites that scroll in script and
  // scroll-snap pages then scroll the way they would unmagnified.
  const pan = (event) => {
    if (!event.isTrusted || event.ctrlKey) return
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1
    const wantX = x + event.deltaX * unit / scale / innerWidth, wantY = y + event.deltaY * unit / scale / innerHeight
    const nextX = clamp(wantX, scale), nextY = clamp(wantY, scale)
    const restX = (wantX - nextX) * innerWidth, restY = (wantY - nextY) * innerHeight
    const sideways = restX === 0 ? null : scroller(event.target, true, restX)
    const down = restY === 0 ? null : scroller(event.target, false, restY)
    const moved = nextX !== x || nextY !== y
    if (!moved && sideways === null && down === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (sideways !== null) scrollOn(sideways, 'left', restX)
    if (down !== null) scrollOn(down, 'top', restY)
    if (!moved) return
    x = nextX
    y = nextY
    publish()
  }
  addEventListener('wheel', (event) => {
    if (!event.isTrusted || !event.ctrlKey || event.deltaMode !== 0) return
    const px = event.clientX / innerWidth, py = event.clientY / innerHeight
    // A site with its own pinch (maps, canvases) claims it with preventDefault.
    setTimeout(() => {
      if (event.defaultPrevented) return
      const next = Math.min(${MAX_MAGNIFICATION}, Math.max(1, scale * Math.exp(-event.deltaY / 100)))
      // The page point under the fingers stays under them.
      x = clamp(px - scale * (px - x) / next, next)
      y = clamp(py - scale * (py - y) / next, next)
      if (scale === 1 && next > 1) addEventListener('wheel', pan, { capture: true, passive: false })
      if (next === 1) removeEventListener('wheel', pan, { capture: true })
      scale = next
      publish()
    })
  }, { passive: true })
  // A sideways two-finger swipe that nothing on the page can scroll is history, the way
  // Safari and Chrome do it: fingers to the right go back. An arrow at that edge follows
  // the fingers once there is a page to go to, and letting go past the threshold steps
  // one page; pulling back under it cancels. The DOM sees no finger lift, so the swipe
  // ends when the wheel stream (momentum included) goes quiet; holding still past the
  // threshold therefore counts as letting go. The document itself never
  // claims the swipe: in Manor's narrow pane a site's desktop min-width spills sideways
  // (Wikipedia at 640-1000px), and that spill would eat every first swipe. Only a real
  // inner scroller (a table, code, a carousel) keeps it. Frames leave it to the top page.
  if (globalThis.top !== globalThis) return
  let sx = 0, sy = 0, axis = '', quiet = 0, allowed = null, arrow = null
  // What the fingers are over while a gesture is live.
  let under = null
  const direction = () => sx < 0 ? 'back' : 'forward'
  const progress = () => allowed?.[direction()] ? Math.min(Math.abs(sx) / ${SWIPE_DISTANCE}, 1) : 0
  const draw = (ending) => {
    const p = progress()
    if (arrow === null && (p === 0 || ending)) return
    if (arrow === null) {
      const host = document.createElement('manor-swipe')
      for (const [key, value] of [['all', 'initial'], ['position', 'fixed'], ['inset', '0'], ['pointer-events', 'none'], ['z-index', '2147483647']]) host.style.setProperty(key, value, 'important')
      const circle = document.createElement('div')
      circle.style.cssText = 'position:absolute;top:calc(50% - 68px);width:136px;height:136px;border-radius:50%;display:flex;align-items:center;box-sizing:border-box;padding:0 10px;background:rgb(74 74 76 / 0.94);color:white'
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      for (const [key, value] of [['viewBox', '0 0 24 24'], ['width', '46'], ['height', '46'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '3.2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) svg.setAttribute(key, value)
      // HugeIcons ArrowLeft02, stroke rounded.
      for (const d of ['M5.5 12.002H19', 'M11 18.002C11 18.002 5 13.583 5 12.002C5 10.421 11 6.002 11 6.002']) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', d)
        svg.append(path)
      }
      circle.append(svg)
      host.attachShadow({ mode: 'closed' }).append(circle)
      document.documentElement.append(host)
      arrow = { host, circle, svg }
    }
    const back = direction() === 'back', { host, circle, svg } = arrow
    circle.style.left = back ? '0' : 'auto'
    circle.style.right = back ? 'auto' : '0'
    // The arrow sits in the part of the circle that shows, against the far edge.
    circle.style.justifyContent = back ? 'flex-end' : 'flex-start'
    svg.style.transform = back ? '' : 'scaleX(-1)'
    svg.style.opacity = p === 1 ? '1' : '0.5'
    circle.style.transition = ending ? 'transform 180ms ease-out, opacity 180ms ease-out' : 'none'
    // Hidden past the edge at rest; at full travel 68 of its 136px show, like Chrome's.
    const hidden = ending && p < 1 ? 1 : 1 - p
    circle.style.transform = 'translateX(' + (back ? -1 : 1) * (68 + 68 * hidden) + 'px)'
    circle.style.opacity = ending && p === 1 ? '0' : '1'
    if (ending) { arrow = null; setTimeout(() => host.remove(), 200) }
  }
  // Manor answers a swipe's start with which way there is a page to go.
  globalThis.__manorSwipeHistory = (back, forward) => { if (axis === 'x') { allowed = { back, forward }; draw(false) } }
  const release = () => {
    if (axis === 'x' && progress() === 1) send(JSON.stringify({ swipe: direction() }))
    draw(true)
    sx = 0; sy = 0; axis = ''; allowed = null; under = null
  }
  // overscroll-behavior is how a page opts out of overscroll navigation, as in Chrome.
  const claimsSideways = (target, delta) => chain(target, true, delta) !== null ||
    /(contain|none)/.test(getComputedStyle(document.documentElement).overscrollBehaviorX)
  // The page keeps the rest of the gesture: the arrow goes and nothing steps.
  const claim = () => {
    if (axis === 'x') { allowed = null; draw(true) }
    axis = 'y'
  }
  // A page that cancels the wheel (Figma, Miro, maps) pans its own canvas. Read once
  // every page listener has run.
  const wheel = (event, target) => {
    clearTimeout(quiet)
    if (axis !== 'y') sx += event.deltaX
    if (event.defaultPrevented) claim()
    quiet = setTimeout(release, progress() === 1 ? ${SWIPE_RELEASE_MS} : ${SWIPE_ABANDON_MS})
    if (axis === 'y') return
    if (axis === 'x') { draw(false); return }
    // The first few pixels decide the gesture's axis, so a slightly diagonal start still counts.
    sy += event.deltaY
    if (Math.abs(sx) + Math.abs(sy) < 8) return
    axis = Math.abs(sx) > Math.abs(sy) * 2 && !claimsSideways(target, sx) ? 'x' : 'y'
    if (axis === 'x') send(JSON.stringify({ swipe: 'start' }))
  }
  // A sideways scroller under the fingers that moves during the gesture consumed it, as
  // Chrome latches a gesture to its scroller, even when one wheel step carried it to its
  // edge. A vertical list drifting a few pixels, or a scroll elsewhere, is not this gesture's.
  addEventListener('scroll', (event) => {
    const node = event.target
    if (under instanceof Node && node instanceof Element && node !== document.body && node !== document.documentElement &&
        node.scrollWidth > node.clientWidth + 1 && node.contains(under)) claim()
  }, { capture: true, passive: true })
  addEventListener('wheel', (event) => {
    if (!event.isTrusted || event.ctrlKey || scale > 1 || event.deltaMode !== 0) return
    const target = event.target
    under = target
    setTimeout(() => wheel(event, target))
  }, { passive: true })
})()`

async function listenForPinch(contents: WebContents): Promise<void> {
  await contents.debugger.sendCommand('Runtime.addBinding', { name: PINCH_BINDING, executionContextName: PINCH_WORLD })
  await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PINCH_SOURCE, worldName: PINCH_WORLD, runImmediately: true })
}

async function navigateWithCdp(contents: WebContents, url: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      contents.removeListener('did-finish-load', finish)
      contents.removeListener('did-fail-load', fail)
      signal.removeEventListener('abort', interrupt)
    }
    const interrupt = () => {
      cleanup()
      reject(signal.reason)
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    const fail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return
      cleanup()
      reject(new Error(`Browser navigation failed (${errorCode}). ${errorDescription}`))
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Browser navigation timed out.'))
    }, NAVIGATION_TIMEOUT_MS)

    signal.addEventListener('abort', interrupt, { once: true })
    contents.once('did-finish-load', finish)
    contents.on('did-fail-load', fail)
    void contents.debugger.sendCommand('Page.navigate', { url }).then(
      (result) => {
        const errorText = asRecord(result)?.errorText
        if (typeof errorText !== 'string' || errorText === '') return
        cleanup()
        reject(new Error(`Browser navigation failed. ${errorText}`))
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function readDocumentSnapshot(value: unknown): {
  focusedSelector: string | null
  visibleText: string
  interactiveElements: BrowserInteractiveElement[]
} {
  const result = asRecord(value)
  const rawElements = Array.isArray(result?.interactiveElements) ? result.interactiveElements : []
  return {
    focusedSelector: typeof result?.focusedSelector === 'string' ? result.focusedSelector : null,
    visibleText: typeof result?.visibleText === 'string' ? result.visibleText : '',
    interactiveElements: rawElements.flatMap((raw) => {
      const item = asRecord(raw)
      const bounds = asRecord(item?.bounds)
      if (typeof item?.selector !== 'string' || typeof item.tag !== 'string' || bounds === undefined) return []
      const { x, y, width, height } = bounds
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof width !== 'number' ||
        typeof height !== 'number'
      ) return []
      return [{
        selector: item.selector,
        tag: item.tag,
        ...(typeof item.role === 'string' ? { role: item.role } : {}),
        ...(typeof item.label === 'string' ? { label: item.label } : {}),
        ...(typeof item.text === 'string' ? { text: item.text } : {}),
        ...(typeof item.type === 'string' ? { type: item.type } : {}),
        bounds: { x, y, width, height },
      }]
    }),
  }
}

async function evaluateValue(contents: WebContents, expression: string, contextId?: number): Promise<unknown> {
  const response = asRecord(await contents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...(contextId === undefined ? {} : { contextId }),
  }))
  if (response?.exceptionDetails !== undefined) throw new Error('The browser page rejected the action.')
  return asRecord(response?.result)?.value
}

/**
 * A file an agent delivered opens as Manor's `?view=1` wrapper, marked with a
 * `manor-view` meta, whose one child frame is the page itself. Picking page context
 * there must run in that frame, in an isolated world so the page's own scripts never
 * see the picker; any other page picks in its main frame (undefined).
 */
async function deliveredPageWorld(contents: WebContents): Promise<number | undefined> {
  let address: URL
  try { address = new URL(contents.getURL()) } catch { return undefined }
  if (address.searchParams.get('view') !== '1') return undefined
  if (await evaluateValue(contents, `document.querySelector('meta[name="manor-view"]') !== null`) !== true) return undefined
  const tree = asRecord(asRecord(await contents.debugger.sendCommand('Page.getFrameTree'))?.frameTree)
  const children = tree?.childFrames
  const frameId = Array.isArray(children) ? asRecord(asRecord(children[0])?.frame)?.id : undefined
  if (typeof frameId !== 'string') return undefined
  const world = asRecord(await contents.debugger.sendCommand('Page.createIsolatedWorld', { frameId, worldName: 'manor-page-context' }))
  return typeof world?.executionContextId === 'number' ? world.executionContextId : undefined
}

function checkedSelector(raw: string): string {
  const selector = raw.trim()
  if (selector === '' || selector.length > 2_000) throw new Error('Browser selector is invalid.')
  return selector
}

function watchPossibleNavigation(contents: WebContents): { done: Promise<void>; cancel(): void } {
  let started = false
  let settle: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    const idle = setTimeout(() => finish(), 250)
    const hard = setTimeout(() => finish(), 10_000)
    const start = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame) return
      started = true
      clearTimeout(idle)
    }
    const loaded = () => {
      if (started) finish()
    }
    const inPage = () => {
      if (started) finish()
    }
    const finish = () => {
      clearTimeout(idle)
      clearTimeout(hard)
      contents.removeListener('did-start-navigation', start)
      contents.removeListener('did-finish-load', loaded)
      contents.removeListener('did-navigate-in-page', inPage)
      settle = undefined
      resolve()
    }
    settle = finish
    contents.on('did-start-navigation', start)
    contents.on('did-finish-load', loaded)
    contents.on('did-navigate-in-page', inPage)
  })
  return { done, cancel: () => settle?.() }
}

function formatRemoteValue(raw: unknown): string {
  const value = asRecord(raw)
  if (value === undefined) return ''
  if (typeof value.value === 'string') return value.value
  if (value.value !== undefined) return JSON.stringify(value.value)
  return typeof value.description === 'string' ? value.description : ''
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
