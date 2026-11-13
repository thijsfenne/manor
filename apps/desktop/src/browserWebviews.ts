import { WebContentsView, webContents, type BrowserWindow, type Session, type WebContents, type WebPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { BrowserMagnification, BrowserViewportBounds, BrowserWebviewSnapshot, BrowserWebviewSurface } from '@manor/contracts'
import { withTimeout } from './browserValues'
import { registerBrowserPainting, withBrowserPainting } from './browserPainting'

export const BROWSER_WEBVIEWS_CHANNEL = 'manor:browser:webviews'
const GUEST_PARTITION = 'manor-browser-webview'
const GUEST_PRELOAD = { id: 'manor-browser-guest', type: 'frame', filePath: path.join(__dirname, 'browserGuestPreload.js') } as const
let registryRevision = 0
type Presentation = BrowserWebviewSurface['presentation']

export interface BrowserPageView {
  readonly webContents: WebContents
  getBounds(): BrowserViewportBounds
  /** `fill` means the bounds are the whole frame, with no emulated viewport fitted inside. */
  present(bounds: BrowserViewportBounds, presentation: Presentation, fill?: boolean): Promise<void>
  focusForKeyboard(): Promise<() => Promise<void>>
  /** Pinch magnification, drawn by Manor's window around the guest; `undefined` is 100%. */
  magnify?(magnification: BrowserMagnification | undefined): void
  /** Draws a popup page over this one, following its place and visibility until it closes. */
  overlay(contents: WebContents): void
  close(): void
}

/** The shell keeps this guard even while the browser manager is being replaced. */
export function guardWebviewAttachments(
  window: BrowserWindow,
  current: () => BrowserWebviews | undefined,
): void {
  window.webContents.on('will-attach-webview', (event) => {
    if (!current()?.acceptingFor(window)) event.preventDefault()
  })
}

/** Owns admission and layout; React owns only the lifetime of the matching DOM nodes. */
export class BrowserWebviews {
  private readonly views = new Map<string, GuestView>()
  private revision = ++registryRevision
  private closed = false

  constructor(private readonly window: BrowserWindow, private readonly profile: Session) {
    registerBrowserPainting(window.webContents, async (active) => {
      if (!window.webContents.isDestroyed()) window.webContents.setBackgroundThrottling(!active)
    })
    window.webContents.on('will-attach-webview', this.admit)
    // Registered on the browser Session rather than per webview, so sign-in popups,
    // which are not webviews, get the same script. It reports and fills logins from
    // an isolated world the page cannot reach.
    if (!profile.getPreloadScripts().some((script) => script.id === GUEST_PRELOAD.id)) {
      profile.registerPreloadScript(GUEST_PRELOAD)
    }
  }

  /** The shell acknowledges guest layout even when the whole window is hidden. */
  withShellPainting(work: () => Promise<void>): Promise<void> {
    return withBrowserPainting(this.window.webContents, work)
  }

  acceptingFor(window: BrowserWindow): boolean { return !this.closed && this.window === window }

  list(): BrowserWebviewSnapshot {
    const zoom = this.window.webContents.getZoomFactor()
    return { revision: this.revision, surfaces: [...this.views.values()].map((view) => view.surface(zoom)) }
  }

  async create(id: string): Promise<BrowserPageView> {
    if (this.closed) throw new Error('The browser webview host is closed.')
    if (this.views.has(id)) throw new Error('This browser guest already exists.')
    const view = new GuestView(id, this)
    this.views.set(id, view)
    this.changed(view)
    try {
      await withTimeout(view.ready, 8000)
      return view
    } catch (error) {
      view.close()
      throw error
    }
  }

  /** Resolves registration immediately; waiting for layout here would deadlock React. */
  async attach(id: string, token: string, contentsId: number): Promise<void> {
    const view = this.require(id, token)
    const contents = webContents.fromId(contentsId)
    if (!view.admitted || !contents || contents.isDestroyed() || contents.getType() !== 'webview' ||
        contents.hostWebContents !== this.window.webContents || contents.session !== this.profile) {
      throw new Error('This webview does not belong to the requested browser page.')
    }
    if (!view.attached && contents.getURL() !== view.src) {
      let ready = () => {}
      const loaded = new Promise<void>((resolve) => { ready = resolve; contents.once('dom-ready', ready) })
      try { await withTimeout(loaded, 2000) }
      finally { contents.off('dom-ready', ready) }
      if (this.require(id, token) !== view || contents.getURL() !== view.src) throw new Error('Unexpected initial browser document.')
    }
    if (view.attached && view.webContents !== contents) throw new Error('This browser page already has a guest.')
    view.attach(contents)
  }

  presented(id: string, token: string, revision: number): void {
    this.require(id, token).presented(revision)
  }

  private require(id: string, token: string): GuestView {
    const view = this.views.get(id)
    if (!view || view.token !== token) throw new Error('This browser guest is no longer current.')
    return view
  }

  private readonly admit = (event: Electron.Event, preferences: WebPreferences, params: Record<string, string>) => {
    const view = [...this.views.values()].find((candidate) => candidate.src === params.src)
    if (!view || view.admitted || params.partition !== GUEST_PARTITION) { event.preventDefault(); return }
    // The renderer knows an inert partition alias, never the Dia storage path.
    // Electron must use the same managed Session as navigation, cookies and CDP.
    view.admitted = true
    preferences.session = this.profile
    delete preferences.partition
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.nodeIntegrationInWorker = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false
    preferences.backgroundThrottling = true
    preferences.spellcheck = false
    preferences.webviewTag = false
    // The shell decides when the window goes fullscreen, see `bindPageFullscreen`.
    preferences.disableHtmlFullscreenWindowResize = true
  }

  /** Native views sit above the whole renderer; the page area is the only place for one. */
  addOverlay(view: WebContentsView): void { if (!this.window.isDestroyed()) this.window.contentView.addChildView(view) }
  removeOverlay(view: WebContentsView): void { if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view) }

  changed(view?: GuestView): void {
    this.revision = ++registryRevision
    if (view) view.revision = this.revision
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) this.window.webContents.send(BROWSER_WEBVIEWS_CHANNEL, this.list())
  }

  remove(view: GuestView): void {
    if (this.views.get(view.id) !== view) return
    this.views.delete(view.id)
    this.changed()
  }

  async keyboardFocus(contentsId: number, restore: boolean): Promise<void> {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return
    await withTimeout(this.window.webContents.executeJavaScript(`(() => {
      const guest = [...document.querySelectorAll('webview')].find(element => {
        try { return element.getWebContentsId() === ${contentsId} } catch { return false }
      })
      if (!guest) return
      const key = '__manorRestoreKeyboardFocus'
      if (${restore}) { guest[key]?.(); delete guest[key]; return }
      const wrapper = guest.closest('[data-browser-webview]') || guest
      const previous = document.activeElement, inert = wrapper.inert
      guest[key] = () => {
        wrapper.inert = inert
        if (document.activeElement === guest && previous?.isConnected) previous.focus()
      }
      wrapper.inert = false
      guest.focus()
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })()`), 2000)
  }

  destroy(id: string): void { this.views.get(id)?.close() }

  close(): void {
    this.closed = true
    this.window.webContents.off('will-attach-webview', this.admit)
    for (const view of [...this.views.values()]) view.close()
  }
}

class GuestView implements BrowserPageView {
  readonly token = randomUUID()
  readonly src = `about:blank#manor-${this.token}`
  revision = 0
  admitted = false
  private contents: WebContents | undefined
  private bounds = { x: 0, y: 0, width: 1280, height: 720 }
  private presentation: Presentation = 'hidden'
  private fill = false
  private painting = false
  private magnification: BrowserMagnification | undefined
  private applied = -1
  private closed = false
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  readonly ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
  private readonly waiting = new Set<() => void>()
  private popup: WebContentsView | null = null

  constructor(readonly id: string, private readonly registry: BrowserWebviews) {}

  overlay(contents: WebContents): void {
    if (this.closed || contents.isDestroyed()) return
    const view = new WebContentsView({ webContents: contents })
    this.popup = view
    this.registry.addOverlay(view)
    contents.once('destroyed', () => {
      this.registry.removeOverlay(view)
      if (this.popup === view) this.popup = null
    })
    this.placeOverlay()
    if (this.presentation === 'sidebar') contents.focus()
  }

  /** Only the docked browser shows it; hidden tabs and the small floating preview keep it waiting. */
  private placeOverlay(): void {
    if (this.popup === null) return
    this.popup.setBounds(this.bounds)
    this.popup.setVisible(this.presentation === 'sidebar')
  }

  get attached(): boolean { return this.contents !== undefined }
  get webContents(): WebContents {
    if (!this.contents) throw new Error('The browser guest is not attached yet.')
    return this.contents
  }

  attach(contents: WebContents): void {
    if (this.closed || this.contents) return
    this.contents = contents
    contents.setBackgroundThrottling(true)
    registerBrowserPainting(contents, async (active) => {
      if (this.closed || this.painting === active) return
      this.painting = active
      // Wake even when the entire Manor window is occluded. Restore throttling
      // before hiding the guest so Chromium observes a fresh visibility change.
      contents.setBackgroundThrottling(!active)
      this.registry.changed(this)
      await this.waitForPresentation()
    })
    contents.on('did-finish-load', () => {
      if (this.painting && !contents.isDestroyed()) contents.setBackgroundThrottling(false)
    })
    contents.once('destroyed', () => this.close())
    this.resolveReady()
  }

  surface(zoom: number): BrowserWebviewSurface {
    return { id: this.id, token: this.token, src: this.src, partition: GUEST_PARTITION,
      revision: this.revision, presentation: this.presentation, ...(this.fill ? { fill: true as const } : {}),
      ...(this.painting ? { painting: true as const } : {}),
      ...(this.magnification ? { magnify: this.magnification } : {}),
      bounds: { x: this.bounds.x / zoom, y: this.bounds.y / zoom,
        width: this.bounds.width / zoom, height: this.bounds.height / zoom } }
  }

  async focusForKeyboard(): Promise<() => Promise<void>> {
    const id = this.webContents.id
    try { await this.registry.keyboardFocus(id, false) }
    catch (error) { await this.registry.keyboardFocus(id, true).catch(() => {}); throw error }
    return () => this.registry.keyboardFocus(id, true).catch(() => {})
  }

  getBounds(): BrowserViewportBounds { return { ...this.bounds } }

  /** No layout revision: magnifying never moves the guest, so nothing waits for it. */
  magnify(magnification: BrowserMagnification | undefined): void {
    if (this.closed || (!magnification && !this.magnification)) return
    this.magnification = magnification
    this.registry.changed()
  }

  async present(bounds: BrowserViewportBounds, presentation: Presentation, fill = false): Promise<void> {
    if (this.closed) throw new Error('This browser guest is closed.')
    if (presentation !== this.presentation || fill !== this.fill || Object.keys(bounds).some((key) =>
      bounds[key as keyof BrowserViewportBounds] !== this.bounds[key as keyof BrowserViewportBounds])) {
      this.bounds = { ...bounds }
      this.presentation = presentation
      this.fill = fill
      this.registry.changed(this)
      this.placeOverlay()
    }
    await this.waitForPresentation()
  }

  private async waitForPresentation(): Promise<void> {
    const revision = this.revision
    if (this.applied >= revision) return
    let finish = () => {}
    const ready = new Promise<void>((resolve) => { finish = resolve; this.waiting.add(resolve) })
    try {
      await this.registry.withShellPainting(() => withTimeout(ready, 5000))
      if (this.closed || this.applied < revision) throw new Error('The browser layout was interrupted.')
    } finally { this.waiting.delete(finish) }
  }

  presented(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision > this.revision) throw new Error('Invalid browser layout revision.')
    this.applied = Math.max(this.applied, revision)
    if (this.applied === this.revision) for (const resolve of this.waiting) resolve()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.rejectReady(new Error('The browser guest was closed before attachment.'))
    for (const resolve of this.waiting) resolve()
    this.waiting.clear()
    this.registry.remove(this)
    if (this.popup !== null && !this.popup.webContents.isDestroyed()) this.popup.webContents.close()
    if (this.contents && !this.contents.isDestroyed()) this.contents.close()
  }
}
