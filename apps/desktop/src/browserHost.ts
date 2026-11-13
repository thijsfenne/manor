import type { BrowserWindow, Session } from 'electron'
import { BrowserWebviews } from './browserWebviews'
import { BrowserMirror } from './browserMirror'
import { randomUUID } from 'node:crypto'
import type {
  BrowserFindResult,
  BrowserLoginFillTarget,
  BrowserSecretFillTarget,
  BrowserLoginLookup,
  BrowserPasswordOfferChoice,
  PageContextAttachment,
  BrowserSnapshot,
  BrowserScreenshot,
  BrowserSessionState,
  BrowserViewportBounds,
} from '@manor/contracts'
import { BrowserTab, type PageMarks } from './browserTab'
import type { PagePasswords } from './browserPasswordAutofill'
import type { PageAdblock } from './browserAdblock'
import { parseBrowserBounds } from './browserValues'

/**
 * A runaway guard, not a working limit: a page or agent opening popups in a loop
 * stops here. The Browser destination drops the renderer of tabs unseen for a while
 * (`discardUnseen`), so a long strip there costs little. Nobody should meet it by working.
 */
const MAX_TABS = 50
const MAX_CLOSED_TABS = 25

/** One chat's tabs; their DOM guests remain mounted through presentation changes. */
export class BrowserHost {
  private readonly tabs: BrowserTab[] = []
  /** Addresses of closed tabs, newest last, for ⌘⇧T. */
  private readonly closedUrls: string[] = []
  private activeId: string | null = null
  /** Popups that opened behind the active tab and have not been looked at yet. */
  private readonly unseen = new Set<string>()
  private pinnedCount = 0
  private bounds: BrowserViewportBounds | null = null
  private visible = false
  private presentation: 'sidebar' | 'floating' = 'sidebar'
  private closed = false
  private mirror: BrowserMirror | null = null
  /** Tabs that were active before the current one, most recent last; closing returns there. */
  private readonly previous: string[] = []
  /** When each tab was last on screen, pinned or audible; read by `discardUnseen`. */
  private readonly seenAt = new Map<string, number>()

  constructor(
    private readonly window: BrowserWindow,
    private readonly browserSession: Session,
    private readonly onChanged: () => void = () => {},
    private readonly webviews = new BrowserWebviews(window, browserSession),
    private readonly onVisit: (url: string, title: string) => void = () => {},
    private readonly onTitle: (url: string, title: string) => void = () => {},
    private readonly onPopup: (url: string) => void = () => {},
    private readonly marks?: PageMarks,
    private readonly passwords?: PagePasswords,
    private readonly adblock?: PageAdblock,
  ) {}

  hasPreviewWindow(): boolean { return this.mirror !== null }

  audible(): boolean { return this.tabs.some((tab) => tab.audible()) }

  /**
   * Drops the page of every tab nobody has seen for `afterMs`, keeping the tab itself.
   * Pinned tabs, tabs making sound and the tab on screen always stay live.
   */
  discardUnseen(afterMs: number, now = Date.now()): void {
    this.tabs.forEach((tab, index) => {
      const onScreen = tab.id === this.activeId && (this.visible || this.mirror !== null)
      const seen = this.seenAt.get(tab.id)
      if (index < this.pinnedCount || onScreen || tab.audible() || seen === undefined) this.seenAt.set(tab.id, now)
      else if (now - seen >= afterMs) tab.discard()
    })
  }

  /** A tab coming onto or leaving the screen restarts its unseen clock at the next sweep. */
  private markSeen(tab: BrowserTab | undefined): void {
    if (tab !== undefined) this.seenAt.delete(tab.id)
  }

  /** The page on screen: the active tab's sign-in popup while it is open, else the tab's page. */
  activeWebContents(): Electron.WebContents | undefined { return this.active()?.visibleContents() }

  state(): Omit<BrowserSessionState, 'chatId'> {
    return { tabs: this.tabs.map((tab, index) => ({ ...tab.state(),
      ...(index < this.pinnedCount ? { pinned: true } : {}),
      ...(this.unseen.has(tab.id) ? { unseen: true } : {}),
    })), activeTabId: this.activeId,
      ...(this.mirror === null ? {} : { previewWindowOpen: true }) }
  }

  async setBounds(raw: unknown, presentation: 'sidebar' | 'floating' = this.presentation): Promise<BrowserViewportBounds> {
    const measured = parseBrowserBounds(raw)
    const zoom = this.window.webContents.getZoomFactor()
    this.bounds = { x: Math.round(measured.x * zoom), y: Math.round(measured.y * zoom),
      width: Math.max(1, Math.round(measured.width * zoom)), height: Math.max(1, Math.round(measured.height * zoom)) }
    this.presentation = presentation
    await this.reseat(this.active())
    return this.bounds
  }

  async setVisible(visible: boolean): Promise<void> {
    if (this.visible === visible) return
    if (!visible) await this.active()?.cancelPageContextSelection()
    this.markSeen(this.active())
    this.visible = visible
    await this.reseat(this.active())
  }

  async newTab(): Promise<void> {
    await this.select(this.addTab().id)
  }

  /**
   * A page's popup opens behind the active tab, so a site can never move what is being
   * looked at. Nothing tells a click by the user apart from a script or an agent's
   * synthetic click, so there is no foreground exception. The strip marks it new.
   */
  async openInBackground(url: string): Promise<void> {
    const tab = this.addTab()
    this.unseen.add(tab.id)
    this.onChanged()
    await tab.ensureView()
    if (this.closed || !this.tabs.includes(tab)) return
    await this.park(tab)
    await tab.navigate(url)
    this.onChanged()
  }

  private addTab(): BrowserTab {
    if (this.closed) throw new Error('This browser host is closed.')
    if (this.tabs.length >= MAX_TABS) {
      throw new Error(`This chat's browser already has ${MAX_TABS} tabs open.`)
    }
    const tab = new BrowserTab(
      `tab_${randomUUID()}`,
      this.browserSession,
      this.onChanged,
      this.onPopup,
      (id) => this.webviews.create(id),
      this.onVisit,
      this.onTitle,
      this.marks,
      this.passwords,
      this.adblock,
    )
    this.tabs.push(tab)
    return tab
  }

  /**
   * Recreates a remembered strip. Live views were torn down; only URLs survived.
   * A host that already has tabs is the current session, not a restore target.
   * Only the active tab creates a page. The others load when selected.
   */
  async restoreTabs(urls: string[], activeIndex: number, pinnedCount = 0): Promise<void> {
    if (this.tabs.length > 0 || urls.length === 0) return
    const remembered = urls.slice(0, MAX_TABS)
    const index = Math.min(Math.max(0, activeIndex), remembered.length - 1)
    for (const url of remembered) {
      if (this.closed) return
      this.addTab().restoreUrl(url)
    }
    const active = this.tabs[index]
    this.pinnedCount = Math.min(Math.max(0, pinnedCount), this.tabs.length)
    if (active !== undefined) {
      try { await this.select(active.id) }
      catch (error) { console.warn('[manor] could not restore a browser tab', errorMessage(error)) }
    }
  }

  async select(tabId: string): Promise<void> {
    const next = this.tabs.find((tab) => tab.id === tabId)
    if (next === undefined) throw new Error('That browser tab is not open.')
    this.unseen.delete(tabId)
    if (this.activeId === tabId) {
      await this.reseat(next)
      if (!this.closed) await next.loadRestoredUrl()
      return
    }
    const previous = this.active()
    this.markSeen(previous)
    this.markSeen(next)
    if (previous !== undefined) {
      this.remember(previous.id)
      // Its find bar goes with the switch, so its highlights go too.
      previous.stopFind()
    }
    this.activeId = tabId
    if (previous !== undefined) await previous.cancelPageContextSelection()
    // Each page owns its layout queue. Publish both sides of the switch before
    // waiting for paint, so the incoming page does not pay for two layout rounds.
    await Promise.all([previous === undefined ? undefined : this.park(previous), this.reseat(next)])
    if (this.closed || this.activeId !== tabId) return
    try { await next.loadRestoredUrl() }
    finally { this.onChanged() }
  }

  /** Closes a tab's sign-in popup; its page shows again where it was. */
  fillPassword(loginId: string): void {
    const tab = this.active()
    if (tab === undefined) throw new Error('This chat has no browser tab to fill.')
    tab.fillPassword(loginId)
  }

  /** An agent's fill request reads the active tab, and names it so the fill can insist on it. */
  async findSavedLogin(username?: string): Promise<BrowserLoginLookup> {
    const tab = this.active()
    if (tab === undefined) throw new Error('This chat has no browser tab to fill.')
    return { tabId: tab.id, ...await tab.findSavedLogin(username) }
  }

  async fillSavedLogin(target: BrowserLoginFillTarget): Promise<{ username: string }> {
    const tab = this.active()
    if (tab === undefined || tab.id !== target.tabId) {
      throw new Error('The browser switched to another tab before Fill was clicked, so nothing was filled.')
    }
    return tab.fillSavedLogin(target)
  }

  /** A secret card's page: the active tab, named so the fill can insist on it. */
  async findPasswordField(): Promise<BrowserLoginLookup> {
    const tab = this.active()
    if (tab === undefined) throw new Error('This chat has no browser tab to fill.')
    return { tabId: tab.id, ...await tab.findPasswordField() }
  }

  async fillSecret(target: BrowserSecretFillTarget): Promise<void> {
    const tab = this.active()
    if (tab === undefined || tab.id !== target.tabId) throw new Error('The browser switched to another tab, so nothing was filled.')
    await tab.fillSecret(target)
  }

  answerPasswordOffer(tabId: string, choice: BrowserPasswordOfferChoice): void {
    if (!this.tabs.some((tab) => tab.id === tabId)) throw new Error('This browser tab is no longer open.')
    this.passwords?.answer(tabId, choice)
  }

  cancelSignIn(tabId: string): void {
    const tab = this.tabs.find((open) => open.id === tabId)
    if (tab === undefined) throw new Error('That browser tab is not open.')
    tab.cancelSignIn()
  }

  pinTab(tabId: string, pinned: boolean): void {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) throw new Error('That browser tab is not open.')
    if ((index < this.pinnedCount) === pinned) return
    const [tab] = this.tabs.splice(index, 1)
    if (tab === undefined) return
    if (pinned) this.tabs.splice(this.pinnedCount++, 0, tab)
    else this.tabs.splice(--this.pinnedCount, 0, tab)
    this.onChanged()
  }

  /** A dragged tab lands at `index`, clamped to its own group so pins and tabs never mix. */
  moveTab(tabId: string, index: number): void {
    const from = this.tabs.findIndex((tab) => tab.id === tabId)
    if (from === -1) throw new Error('That browser tab is not open.')
    const pinned = from < this.pinnedCount
    const to = Math.min(Math.max(index, pinned ? 0 : this.pinnedCount), pinned ? this.pinnedCount - 1 : this.tabs.length - 1)
    if (to === from) return
    const [tab] = this.tabs.splice(from, 1)
    if (tab === undefined) return
    this.tabs.splice(to, 0, tab)
    this.onChanged()
  }

  /**
   * The tab that was on screen before this one takes over, so a link read and closed
   * lands back where it came from. Without one, the neighbour below, else the one above.
   */
  async closeTab(tabId: string): Promise<void> {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return
    const [tab] = this.tabs.splice(index, 1)
    if (tab === undefined) return
    const url = tab.state().url
    if (/^https?:/.test(url)) {
      this.closedUrls.push(url)
      if (this.closedUrls.length > MAX_CLOSED_TABS) this.closedUrls.shift()
    }
    this.forget(tabId)
    this.unseen.delete(tabId)
    this.seenAt.delete(tabId)
    if (index < this.pinnedCount) this.pinnedCount -= 1
    if (this.activeId === tabId) {
      this.activeId = null
    }
    tab.close()
    this.webviews.destroy(tab.id)
    if (this.activeId === null) {
      const heir = this.tabs.find((open) => open.id === this.previous.at(-1)) ?? this.tabs[index] ?? this.tabs[index - 1]
      if (heir !== undefined) await this.select(heir.id)
      else this.mirror?.close()
    }
    this.onChanged()
  }

  /** Every agent action runs against the active tab, opening one if there is none. */
  private async requireActive(): Promise<BrowserTab> {
    if (this.tabs.length === 0) await this.newTab()
    const tab = this.active()
    if (tab === undefined) throw new Error("This chat's browser has no open tab.")
    return tab
  }

  async navigate(raw: string): Promise<{ url: string; title: string }> {
    const tab = await this.requireActive()
    await tab.cancelPageContextSelection()
    const result = await tab.navigate(raw)
    this.onChanged()
    return result
  }

  /** The sweep holds off while an agent works here, so every unseen clock restarts once it settles. */
  async endAgentUse(): Promise<void> {
    this.seenAt.clear()
    await this.interruptInput()
  }

  /** Stops input in flight on every tab; the tabs stay held for whoever else is working. */
  async interruptInput(): Promise<void> {
    await Promise.all(this.tabs.map((tab) => tab.endAgentUse()))
  }

  async snapshot(): Promise<BrowserSnapshot> {
    return (await this.requireActive()).snapshot()
  }

  async click(selector: string): Promise<{ url: string; title: string; selector: string }> {
    return (await this.requireActive()).click(selector)
  }

  async type(selector: string, text: string): Promise<{ selector: string }> {
    return (await this.requireActive()).type(selector, text)
  }

  async press(key: string): Promise<{ key: string }> {
    return (await this.requireActive()).press(key)
  }

  async scroll(deltaX: unknown, deltaY: unknown): Promise<{ deltaX: number; deltaY: number }> {
    return (await this.requireActive()).scroll(deltaX, deltaY)
  }

  /** Loading events can publish a surface before its debugger is attached. */
  previewTarget(): { tabId: string; contents: Electron.WebContents } | undefined {
    const tab = this.active()
    const view = tab?.peek()
    return tab !== undefined && view?.webContents.debugger.isAttached()
      ? { tabId: tab.id, contents: view.webContents } : undefined
  }

  async screenshot(): Promise<BrowserScreenshot> {
    return (await this.requireActive()).screenshot()
  }

  async selectPageContext(): Promise<PageContextAttachment | null> {
    return (await this.requireActive()).selectPageContext()
  }

  async cancelPageContextSelection(): Promise<void> {
    await this.active()?.cancelPageContextSelection()
  }

  /** Brings back the most recently closed tab; nothing happens when none was closed. */
  async reopenClosedTab(): Promise<void> {
    const url = this.closedUrls.pop()
    if (url === undefined) return
    try { await this.newTab() }
    catch (error) {
      // A full strip refuses the tab; the closed page stays recoverable for the next try.
      this.closedUrls.push(url)
      throw error
    }
    await this.navigate(url)
  }

  find(query: string, forward: boolean, next: boolean): Promise<BrowserFindResult> {
    const tab = this.active()
    return tab === undefined ? Promise.resolve({ matches: 0, active: 0 }) : tab.find(query, forward, next)
  }

  stopFind(): void {
    this.active()?.stopFind()
  }

  async goBack(): Promise<void> {
    (await this.requireActive()).goBack()
  }

  async goForward(): Promise<void> {
    (await this.requireActive()).goForward()
  }

  async reload(): Promise<void> {
    const tab = await this.requireActive()
    await tab.cancelPageContextSelection()
    tab.reload()
  }

  /** Switches blocking for the page on screen and reloads it, so the switch shows at once. */
  async setSiteAdblock(blocking: boolean): Promise<void> {
    if (this.adblock === undefined) throw new Error('Ad blocking is not available.')
    const tab = await this.requireActive()
    await tab.cancelPageContextSelection()
    tab.setSiteAdblock(blocking)
  }

  async configure(settings: unknown): Promise<void> {
    await (await this.requireActive()).configure(settings)
  }

  async hardReload(): Promise<void> {
    await (await this.requireActive()).hardReload()
  }

  async openDevTools(): Promise<void> {
    await (await this.requireActive()).openDevTools()
  }

  async openPreviewWindow(): Promise<void> {
    await this.requireActive()
    this.mirror ??= new BrowserMirror(() => { this.mirror = null; this.onChanged() })
    await this.mirror.setTarget(this.previewTarget()?.contents)
    this.mirror?.show()
    this.onChanged()
  }

  async stopLoading(): Promise<void> {
    this.active()?.stopLoading()
  }

  async close(): Promise<void> {
    this.closed = true
    for (const tab of this.tabs.splice(0)) {
      tab.close()
      this.webviews.destroy(tab.id)
    }
    this.activeId = null
    this.previous.length = 0
    this.pinnedCount = 0
    this.mirror?.close()
    this.mirror = null
  }

  private remember(tabId: string): void {
    this.forget(tabId)
    this.previous.push(tabId)
  }

  private forget(tabId: string): void {
    const index = this.previous.indexOf(tabId)
    if (index !== -1) this.previous.splice(index, 1)
  }

  private active(): BrowserTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeId)
  }

  private async reseat(tab: BrowserTab | undefined): Promise<void> {
    if (this.closed || tab === undefined) return
    await tab.setBounds(this.visible && this.bounds ? this.bounds : this.parkedBounds(tab),
      this.visible ? this.presentation : 'hidden')
    if (this.closed || this.activeId !== tab.id) return
    await this.mirror?.setTarget(this.previewTarget()?.contents)
  }

  private async park(tab: BrowserTab): Promise<void> {
    if (!this.closed && tab.peek()) await tab.setBounds(this.parkedBounds(tab), 'hidden')
  }

  private parkedBounds(tab: BrowserTab): BrowserViewportBounds {
    // Natural pages keep their viewport across tab switches. Floating previews
    // and responsive pages still use the default stage to fit their emulated size.
    const bounds = this.presentation === 'sidebar' && !tab.state().settings?.viewport
      ? tab.peek()?.getBounds() : undefined
    return { x: 0, y: 0, width: bounds?.width ?? 1280, height: bounds?.height ?? 720 }
  }

}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
