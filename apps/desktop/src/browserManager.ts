import type { BROWSER_HOME_SESSION_ID as ContractHomeSessionId, BrowserFindResult, BrowserLoginFillTarget, BrowserSecretFillTarget, BrowserLoginLookup, BrowserPasswordOfferChoice, BrowserPreviewUpdate, BrowserScreenshot, BrowserSessionState, BrowserSnapshot, PageContextAttachment, BrowserPreviewImage } from '@manor/contracts'
import type { BrowserWindow, Session } from 'electron'
import { BrowserHost } from './browserHost'
import { withBrowserPainting } from './browserPainting'
import { emptyBrowserHistory, type BrowserHistory } from './browserHistory'
import { BrowserWebviews } from './browserWebviews'
import { noPagePasswords, type PagePasswords } from './browserPasswordAutofill'
import { noPageAdblock, type PageAdblock } from './browserAdblock'
import type { DmTabMemory, DmTabSnapshot } from './dmTabMemory'
import { BrowserActionTimeoutError, persistableUrl, withTimeout } from './browserValues'

const INACTIVITY_MS = 30 * 60 * 1_000

/** The packaged main process cannot load workspace TypeScript, so the id is copied; the type pins it to the contract. */
const BROWSER_HOME_SESSION_ID: typeof ContractHomeSessionId = 'browser:home'

/**
 * How long each kind of parked page lives. A chat's rail browser closes a minute
 * after it leaves the screen once no agent is using it (thirty while one is, and at
 * once when that agent finishes), and its strip comes back on the next open. The Browser surface never closes as a
 * whole; each of its tabs drops its page after five unseen minutes instead.
 */
export interface BrowserLifecycle {
  settledMs: number
  tabDiscardMs: number
  sweepMs: number
}

const LIFECYCLE: BrowserLifecycle = { settledMs: 60_000, tabDiscardMs: 5 * 60_000, sweepMs: 60_000 }

/** Electron only writes a partition to disk when its name carries this prefix. */
export const BROWSER_PROFILE_PARTITION = 'persist:manor-browser'

/**
 * Nothing the host does may outlive the broker's own thirty-second answer budget.
 * Every neighbouring layer already has a clock; without one here a CDP command
 * against a blocked renderer never settles, and the shield stays raised over a page
 * nobody is driving while the panel goes on naming an agent whose turn ended.
 */
const ACTION_TIMEOUT_MS = 25_000
const SEALED_PREVIEW = 'A page that received a secret has no preview.'

interface SessionEntry {
  host: BrowserHost
  inputGeneration: number
  touchedAt: number
  timer: ReturnType<typeof setTimeout>
  bounds?: unknown
  restoring?: Promise<void>
}

const emptyTabMemory: DmTabMemory = { load: () => new Map(), save: () => {} }

/**
 * One lazy set of live tabs per chat over one persistent browser profile. Exactly
 * one chat is on screen at a time, and which one that is belongs to the panel alone:
 * an agent acting in a chat the user is not looking at runs against its parked tabs and
 * never pulls its page in front of the one they are reading.
 *
 * Every chat remembers its tab URLs and active tab across idle teardown and app
 * quit. The live host still dies; opening that chat restores the list.
 */
export class BrowserManager {
  private readonly sessions = new Map<string, SessionEntry>()
  private visibleId: string | null = null
  private previewIntent: { chatId: string; subscriptionId: string; manual?: true } | null = null
  readonly webviews: BrowserWebviews
  private previewCapture: { intent: NonNullable<BrowserManager['previewIntent']>; tabId: string } | null = null
  private previewWork = Promise.resolve()
  /** Updated before async work, so timeout cleanup can never resurrect stale UI. */
  private visibleIntent: { chatId: string; bounds: unknown } | null = null
  /** Serialises the two visibility verbs, which is the only ordering that matters. */
  private visibility = Promise.resolve()
  /**
   * Live host work (readers) versus a profile clear (one writer). A clear must
   * not snapshot the session map, then watch a second chat open a renderer that
   * writes cookies while `session.clearData()` is still running.
   */
  private inflight = 0
  private idle = Promise.resolve()
  private resolveIdle: () => void = () => {}
  private clearLock = Promise.resolve()
  private clearWaiters = 0
  /** Serialises agent actions and page popups within one chat. */
  private readonly actionTails = new Map<string, Promise<void>>()
  /** Chats whose browser an agent is using this turn; their parked pages wait longer. */
  private readonly agentUse = new Set<string>()
  private readonly sweep: ReturnType<typeof setInterval>
  private readonly persisted: Map<string, DmTabSnapshot>
  private readonly saveTabs: (tabs: Map<string, DmTabSnapshot>) => void

  constructor(
    private readonly window: BrowserWindow,
    private readonly browserSession: Session,
    /** Where a changed tab strip goes. The renderer holds no browser state of its own. */
    private readonly onState: (state: BrowserSessionState) => void = () => {},
    private readonly inactivityMs = INACTIVITY_MS,
    private readonly actionTimeoutMs = ACTION_TIMEOUT_MS,
    tabMemory: DmTabMemory = emptyTabMemory,
    private readonly onPreview: (update: BrowserPreviewUpdate) => void = () => {},
    private readonly browserHistory: BrowserHistory = emptyBrowserHistory,
    private readonly lifecycle: BrowserLifecycle = LIFECYCLE,
    private readonly passwords: PagePasswords = noPagePasswords,
    private readonly adblock: PageAdblock = noPageAdblock,
  ) {
    this.webviews = new BrowserWebviews(window, browserSession)
    this.sweep = setInterval(() => {
      if (this.agentUse.has(BROWSER_HOME_SESSION_ID)) return
      this.sessions.get(BROWSER_HOME_SESSION_ID)?.host.discardUnseen(this.lifecycle.tabDiscardMs)
    }, this.lifecycle.sweepMs)
    this.sweep.unref?.()
    this.persisted = tabMemory.load()
    this.saveTabs = (tabs) => tabMemory.save(tabs)
    let cleaned = false
    for (const [chatId, snapshot] of this.persisted) {
      const urls = snapshot.urls.map(persistableUrl)
      if (urls.every((url, index) => url === snapshot.urls[index])) continue
      this.persisted.set(chatId, { ...snapshot, urls })
      cleaned = true
    }
    if (cleaned) this.flush()
  }

  /**
   * A browser key is accepted while a browser page is showing, the Browser stage or a
   * chat's own panel alike, and from a page only when it is that browser's active tab.
   */
  acceptsShortcut(source?: Electron.WebContents): boolean {
    if (this.visibleId === null) return false
    return source === undefined || this.sessions.get(this.visibleId)?.host.activeWebContents() === source
  }

  /** Puts one chat's live page under the panel at the bounds the renderer measured. */
  async show(bounds: unknown, chatId: string, _retiredPersistFlag?: boolean, presentation: 'sidebar' | 'floating' = 'sidebar'): Promise<void> {
    const intent = { chatId, bounds }
    this.visibleIntent = intent
    await this.withHost(async () => {
      if (this.visibleIntent !== intent) return
      const entry = await this.get(chatId)
      await this.sequence(async () => {
        if (this.visibleIntent !== intent || this.sessions.get(chatId) !== entry) return
        if (this.visibleId !== null && this.visibleId !== chatId) {
          const previousId = this.visibleId
          const previous = this.sessions.get(previousId)
          if (previous !== undefined) this.touch(previousId, previous)
          await previous?.host.setVisible(false)
        }
        if (this.visibleIntent !== intent || this.sessions.get(chatId) !== entry) return
        entry.bounds = bounds
        this.visibleId = chatId
        await entry.host.setBounds(bounds, presentation)
        await entry.host.setVisible(true)
      })
    })
    await this.syncPreview()
  }

  /**
   * Parks whatever is on screen with its session intact. The way out of `show`, used
   * whenever the panel stops being the thing to look at: another chat, another
   * panel, a dialog over the stage, or a window that just closed.
   */
  async hide(): Promise<void> {
    this.visibleIntent = null
    await this.withHost(async () => {
      await this.sequence(async () => {
        const visible = this.visibleId === null ? undefined : this.sessions.get(this.visibleId)
        const parkedId = this.visibleId
        if (visible !== undefined && parkedId !== null) {
          this.capture(parkedId, visible.host)
          this.touch(parkedId, visible)
        }
        this.visibleId = null
        await visible?.host.setVisible(false)
      })
    })
    await this.syncPreview()
  }

  async navigate(raw: string, chatId: string): Promise<{ url: string; title: string }> {
    return this.act(chatId, async (host) => this.passwords.redact(await host.navigate(raw)))
  }

  /** An agent's turn reaches for this chat's browser; its parked pages outlive the settle. */
  beginAgentUse(chatId: string): void {
    this.agentUse.add(chatId)
    const entry = this.sessions.get(chatId)
    if (entry !== undefined) this.touch(chatId, entry)
  }

  /**
   * One turn stopped while another still holds these tabs. The broker runs one action
   * per session at a time, so the action in flight is the stopped turn's own.
   */
  async interruptAgentInput(chatId: string): Promise<void> {
    const entry = this.sessions.get(chatId)
    if (entry === undefined) return
    entry.inputGeneration += 1
    await entry.host.interruptInput()
  }

  /** Cleanup never opens a host and never queues behind the input it must interrupt. */
  async endAgentUse(chatId: string): Promise<void> {
    const preview = this.previewIntent?.chatId === chatId ? this.previewIntent : null
    this.agentUse.delete(chatId)
    const entry = this.sessions.get(chatId)
    if (entry !== undefined) {
      entry.inputGeneration += 1
      this.touch(chatId, entry)
      await entry.host.endAgentUse()
    }
    if (preview !== null && !preview.manual) await this.stopPreview(preview.subscriptionId)
    // A settled chat whose panel is already shut closes now instead of waiting a minute.
    // Not awaited: the close waits out any action still unwinding, as the idle timer's does.
    if (entry !== undefined && chatId !== BROWSER_HOME_SESSION_ID && this.sessions.get(chatId) === entry &&
        !this.agentUse.has(chatId) && !this.inUse(chatId, entry)) {
      clearTimeout(entry.timer)
      void this.sleep(chatId)
    }
  }

  async startPreview(chatId: string, subscriptionId: string, mode: 'agent' | 'manual' = 'agent'): Promise<void> {
    if (this.previewIntent?.subscriptionId === subscriptionId && this.previewIntent.chatId === chatId) return
    const previous = this.previewIntent
    const intent = { chatId, subscriptionId, ...(mode === 'manual' ? { manual: true as const } : {}) }
    this.previewIntent = intent
    if (previous !== null) this.onPreview({ ...previous, status: 'stopped' })
    // The first agent tool may not have created its tab yet. publish() attaches it.
    await this.syncPreview()
  }

  async stopPreview(subscriptionId?: string): Promise<void> {
    const intent = this.previewIntent
    if (intent === null || (subscriptionId !== undefined && intent.subscriptionId !== subscriptionId)) return
    const target = this.sessions.get(intent.chatId)?.host.previewTarget()
    if (target) {
      try {
        const frame = await this.capturePreview(target.contents)
        if (this.previewIntent === intent) this.onPreview({ ...intent, tabId: target.tabId, status: 'frame', ...frame })
      } catch { /* The last page may have closed with its chat. */ }
    }
    if (this.previewIntent !== intent) return
    this.previewIntent = null
    this.previewCapture = null
    this.onPreview({ ...intent, status: 'stopped' })
  }

  private async capturePreview(contents: Electron.WebContents): Promise<BrowserPreviewImage> {
    if (this.passwords.sealed(contents)) throw new Error(SEALED_PREVIEW)
    const image = await withBrowserPainting(contents, () => withTimeout(contents.capturePage(undefined, { stayHidden: true, stayAwake: true }), 1500))
    // The fill may have landed during the capture.
    if (this.passwords.sealed(contents)) throw new Error(SEALED_PREVIEW)
    const size = image.getSize()
    if (image.isEmpty()) throw new Error('The browser has no preview image.')
    const scale = Math.min(1, 960 / size.width, 960 / size.height)
    const thumbnail = scale < 1 ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }) : image
    return { screenshot: `data:image/jpeg;base64,${thumbnail.toJPEG(80).toString('base64')}`, ...size }
  }

  /** DOM guests are live; only initial/final thumbnails cross this bridge. */
  private syncPreview(): Promise<void> {
    const sync = async () => {
      const intent = this.previewIntent
      if (!intent) return
      const target = this.sessions.get(intent.chatId)?.host.previewTarget()
      if (!target || (this.previewCapture?.intent === intent && this.previewCapture.tabId === target.tabId)) return
      this.previewCapture = { intent, tabId: target.tabId }
      try {
        const frame = await this.capturePreview(target.contents)
        if (this.previewIntent === intent) this.onPreview({ ...intent, tabId: target.tabId, status: 'frame', ...frame })
      } catch {
        if (this.previewIntent === intent) this.onPreview({ ...intent, status: 'unavailable' })
      }
    }
    const work = this.previewWork.then(sync)
    this.previewWork = work.catch(() => {})
    return work
  }

  /** What a page shows an agent passes through `redact`, so a page echoing a filled password cannot hand it on. */
  async snapshot(chatId: string): Promise<BrowserSnapshot> {
    return this.act(chatId, async (host) => this.passwords.redact(await host.snapshot()))
  }

  async click(selector: string, chatId: string): Promise<{ url: string; title: string; selector: string }> {
    return this.act(chatId, async (host) => this.passwords.redact(await host.click(selector)))
  }

  async type(selector: string, text: string, chatId: string): Promise<{ selector: string }> {
    return this.act(chatId, (host) => host.type(selector, text))
  }

  async press(key: string, chatId: string): Promise<{ key: string }> {
    return this.act(chatId, (host) => host.press(key))
  }

  async scroll(deltaX: number, deltaY: number, chatId: string): Promise<{ deltaX: number; deltaY: number }> {
    return this.act(chatId, (host) => host.scroll(deltaX, deltaY))
  }

  async screenshot(chatId: string): Promise<BrowserScreenshot> {
    return this.act(chatId, async (host) => this.passwords.redact(await host.screenshot()))
  }

  /** User-owned selection. No agent lock and no action timeout while they point. */
  async selectPageContext(chatId: string): Promise<PageContextAttachment | null> {
    return this.withHost(async () => {
      if (this.visibleId !== chatId) throw new Error('Open this chat browser before selecting page context.')
      const entry = await this.get(chatId)
      return entry.host.selectPageContext()
    })
  }

  /** Listing is free; selecting is an act on the shared surface like any other. */
  async tabs(chatId: string, select?: string): Promise<BrowserSessionState> {
    if (select === undefined) {
      return this.withHost(async () => this.stateOf(chatId, (await this.get(chatId)).host))
    }
    return this.act(chatId, async (host) => {
      await host.select(select)
      return this.stateOf(chatId, host)
    })
  }

  /** A user may open a blank tab; an agent supplies its destination in the same action. */
  async newTab(chatId: string, url?: string): Promise<BrowserSessionState> {
    if (url !== undefined) {
      return this.act(chatId, async (host) => {
        await host.newTab()
        await host.navigate(url)
        return this.stateOf(chatId, host)
      })
    }
    return this.withHost(async () => {
      const host = (await this.get(chatId)).host
      await host.newTab()
      return this.stateOf(chatId, host)
    })
  }

  async closeTab(tabId: string, chatId: string): Promise<BrowserSessionState> {
    return this.withHost(async () => {
      const host = (await this.get(chatId)).host
      await host.closeTab(tabId)
      return this.stateOf(chatId, host)
    })
  }

  async reopenClosedTab(chatId: string): Promise<BrowserSessionState> {
    return this.withHost(async () => {
      const host = (await this.get(chatId)).host
      await host.reopenClosedTab()
      return this.stateOf(chatId, host)
    })
  }

  async findInPage(chatId: string, query: string, forward: boolean, next: boolean): Promise<BrowserFindResult> {
    return this.withHost(async () => (await this.get(chatId)).host.find(query, forward, next))
  }

  async stopFind(chatId: string): Promise<void> {
    return this.withHost(async () => { (await this.get(chatId)).host.stopFind() })
  }

  /** The user picked a saved login in the chrome; agents reach only `fillSavedLogin`, through their card. */
  async fillPassword(chatId: string, loginId: string): Promise<void> {
    return this.withHost(async () => { (await this.get(chatId)).host.fillPassword(loginId) })
  }

  /** An agent's fill request: the lookup before the user's card, the fill after their click on it. */
  async findSavedLogin(chatId: string, username?: string): Promise<BrowserLoginLookup> {
    return this.act(chatId, (host) => host.findSavedLogin(username))
  }

  async fillSavedLogin(chatId: string, target: BrowserLoginFillTarget): Promise<{ username: string }> {
    return this.act(chatId, (host) => host.fillSavedLogin(target))
  }

  /** A secret card: the page it binds before the user enters anything, the fill after their submit. */
  async findPasswordField(chatId: string): Promise<BrowserLoginLookup> {
    return this.act(chatId, (host) => host.findPasswordField())
  }

  async fillSecret(chatId: string, target: BrowserSecretFillTarget): Promise<void> {
    return this.act(chatId, (host) => host.fillSecret(target))
  }

  async answerPasswordOffer(chatId: string, tabId: string, choice: BrowserPasswordOfferChoice): Promise<void> {
    return this.withHost(async () => { (await this.get(chatId)).host.answerPasswordOffer(tabId, choice) })
  }

  async cancelSignIn(tabId: string, chatId: string): Promise<void> {
    return this.withHost(async () => { (await this.get(chatId)).host.cancelSignIn(tabId) })
  }

  async pinTab(tabId: string, chatId: string, pinned: boolean): Promise<BrowserSessionState> {
    return this.withHost(async () => {
      const host = (await this.get(chatId)).host
      host.pinTab(tabId, pinned)
      this.capture(chatId, host)
      return this.stateOf(chatId, host)
    })
  }

  async moveTab(tabId: string, chatId: string, index: number): Promise<BrowserSessionState> {
    return this.withHost(async () => {
      const host = (await this.get(chatId)).host
      host.moveTab(tabId, index)
      this.capture(chatId, host)
      return this.stateOf(chatId, host)
    })
  }

  async goBack(chatId: string): Promise<void> {
    await this.act(chatId, (host) => host.goBack())
  }

  async goForward(chatId: string): Promise<void> {
    await this.act(chatId, (host) => host.goForward())
  }

  async reload(chatId: string): Promise<void> {
    await this.act(chatId, (host) => host.reload())
  }

  /** Other tabs on the same host, in any chat, show the new switch too. */
  async setSiteAdblock(chatId: string, blocking: boolean): Promise<void> {
    await this.act(chatId, (host) => host.setSiteAdblock(blocking))
    this.republish()
  }

  async configure(chatId: string, settings: unknown): Promise<void> {
    await this.act(chatId, (host) => host.configure(settings))
  }

  async hardReload(chatId: string): Promise<void> {
    await this.act(chatId, (host) => host.hardReload())
  }

  async openDevTools(chatId: string): Promise<void> {
    await this.act(chatId, (host) => host.openDevTools())
  }

  async openPreviewWindow(chatId: string): Promise<void> {
    await this.act(chatId, (host) => host.openPreviewWindow())
  }

  async clearCookies(): Promise<void> {
    await this.withClear(() => this.browserSession.clearStorageData({ storages: ['cookies'] }))
  }

  async clearCache(): Promise<void> {
    await this.withClear(() => this.browserSession.clearCache())
  }

  async stopLoading(chatId: string): Promise<void> {
    await this.withHost(async () => {
      await (await this.get(chatId)).host.stopLoading()
    })
  }

  async close(chatId: string): Promise<void> {
    await this.withHost(async () => {
      if (this.visibleIntent?.chatId === chatId) this.visibleIntent = null
      await this.closeSession(chatId, true)
    })
  }

  /**
   * Drops the live host. `forget` is chat delete and Clear, so the remembered DM
   * list goes with it. Idle teardown and quit keep the list so the next open can
   * restore.
   */
  private async closeSession(chatId: string, forget: boolean): Promise<void> {
    if (this.previewIntent?.chatId === chatId) await this.stopPreview(this.previewIntent.subscriptionId)
    const entry = this.sessions.get(chatId)
    if (entry !== undefined) {
      if (!forget) this.capture(chatId, entry.host)
      this.sessions.delete(chatId)
      clearTimeout(entry.timer)
      if (this.visibleId === chatId) this.visibleId = null
      await this.syncPreview()
      await entry.host.close()
      this.onState({ chatId, tabs: [], activeTabId: null })
    }
    if (forget) this.forget(chatId)
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweep)
    if (this.previewIntent !== null) await this.stopPreview(this.previewIntent.subscriptionId)
    await this.withClear(async () => {
      this.visibleIntent = null
      const ids = [...this.sessions.keys()]
      await Promise.all(ids.map((id) => this.closeSession(id, false)))
      this.webviews.close()
    })
  }

  /**
   * The only way out of remembered login state. Live tabs close first so no renderer
   * can repopulate cookies or storage while Chromium clears the shared profile.
   * Holds the writer lock so a second chat cannot open a host for the length of
   * the close-and-clear, and waits for every in-flight action to leave first.
   */
  async clearData(): Promise<void> {
    if (this.previewIntent !== null) await this.stopPreview(this.previewIntent.subscriptionId)
    await this.withClear(async () => {
      this.visibleIntent = null
      const ids = [...this.sessions.keys()]
      await Promise.all(ids.map((id) => this.closeSession(id, true)))
      this.forgetAll()
      await this.browserSession.clearData()
      this.browserHistory.clearAll()
    })
  }

  history(query?: string) {
    return this.browserHistory.search(query)
  }

  addressMatches(query: string) {
    return this.browserHistory.addressMatches(query)
  }

  private async get(chatId: string): Promise<SessionEntry> {
    if (this.clearWaiters > 0 && this.inflight === 0) {
      throw new Error('Cannot open a browser host while clearing the profile.')
    }
    const existing = this.sessions.get(chatId)
    if (existing !== undefined) {
      this.touch(chatId, existing)
      if (existing.restoring !== undefined) await existing.restoring
      return existing
    }
    const entry: SessionEntry = {
      host: new BrowserHost(
        this.window,
        this.browserSession,
        () => this.publish(chatId),
        this.webviews,
        (url, title) => this.recordVisit(url, title),
        (url, title) => this.updateVisitTitle(url, title),
        (url) => {
          void this.act(chatId, async (host) => {
            if (host !== entry.host) return
            await host.openInBackground(url)
          }, entry.host).catch((error: unknown) => {
            if (this.sessions.get(chatId)?.host !== entry.host) return
            console.warn('[manor] browser popup navigation failed', error instanceof Error ? error.message : String(error))
          })
        },
        this.marks,
        this.passwords,
        this.adblock,
      ),
      touchedAt: Date.now(),
      timer: idleTimer(),
      inputGeneration: 0,
    }
    this.sessions.set(chatId, entry)
    this.touch(chatId, entry)
    const snapshot = this.persisted.get(chatId)
    if (snapshot !== undefined) {
      const restoring = entry.host.restoreTabs(snapshot.urls, snapshot.activeIndex, snapshot.pinnedCount).finally(() => {
        if (this.sessions.get(chatId) === entry) delete entry.restoring
      })
      entry.restoring = restoring
      await restoring
    }
    return entry
  }

  /** One broker-serialized action, with a deadline that also covers restoring its host. */
  private async act<T>(chatId: string, action: (host: BrowserHost) => Promise<T>, expectedHost?: BrowserHost): Promise<T> {
    const previous = this.actionTails.get(chatId)
    const execute = () => {
      if (expectedHost !== undefined && this.sessions.get(chatId)?.host !== expectedHost) {
        return Promise.reject(new Error('The browser page that opened this popup has closed.'))
      }
      return this.withHost(async () => {
      let expired = false
      const run = async () => {
        const getting = this.get(chatId)
        const generation = this.sessions.get(chatId)?.inputGeneration
        const entry = await getting
        if (entry.inputGeneration !== generation) throw new Error('Browser agent use stopped.')
        if (expired || this.sessions.get(chatId) !== entry) throw new BrowserActionTimeoutError()
        // Restoration and selection cleanup share the action's deadline.
        await entry.host.cancelPageContextSelection()
        if (entry.inputGeneration !== generation) throw new Error('Browser agent use stopped.')
        if (expired || this.sessions.get(chatId) !== entry) throw new BrowserActionTimeoutError()
        return action(entry.host)
      }
      try {
        return await withTimeout(run(), this.actionTimeoutMs)
      } catch (error: unknown) {
        // Promise.race cannot cancel CDP. Destroying the timed-out host is the only
        // honest way to guarantee its late action cannot overlap the next broker call.
        if (error instanceof BrowserActionTimeoutError) {
          expired = true
          // The panel's next show restores the strip. Loading it here would add a
          // second navigation budget after the action has already timed out.
          await this.closeSession(chatId, false)
        }
        throw error
      } finally {
        this.publish(chatId)
      }
      })
    }
    const running = previous === undefined ? execute() : previous.then(execute)
    const settled = running.then(() => undefined, () => undefined)
    this.actionTails.set(chatId, settled)
    try {
      return await running
    } finally {
      if (this.actionTails.get(chatId) === settled) this.actionTails.delete(chatId)
    }
  }

  private stateOf(chatId: string, host: BrowserHost): BrowserSessionState {
    return this.passwords.redact({ chatId, ...host.state() })
  }

  /** Every open strip again, after something they all read from changed, such as saved passwords. */
  republish(): void {
    for (const chatId of this.sessions.keys()) this.publish(chatId)
  }

  private publish(chatId: string): void {
    const entry = this.sessions.get(chatId)
    if (entry === undefined) return
    this.onState(this.stateOf(chatId, entry.host))
    if (this.previewIntent?.chatId === chatId || this.visibleId === chatId) void this.syncPreview()
  }

  /** An address carrying a filled password is never stored; it comes back blank, like a one-time callback. */
  private storableUrl(url: string): string {
    return this.passwords.redact(url) === url ? persistableUrl(url) : 'about:blank'
  }

  private recordVisit(url: string, title: string): void {
    if (this.passwords.redact(url) !== url) return
    try { this.browserHistory.record(url, this.passwords.redact(title)) }
    catch (error: unknown) { console.warn('[manor] browser history write failed', error instanceof Error ? error.message : String(error)) }
  }

  private updateVisitTitle(url: string, title: string): void {
    if (this.passwords.redact(url) !== url) return
    try { this.browserHistory.updateTitle(url, this.passwords.redact(title)) }
    catch (error: unknown) { console.warn('[manor] browser history title update failed', error instanceof Error ? error.message : String(error)) }
  }

  private touch(chatId: string, entry: SessionEntry): void {
    entry.touchedAt = Date.now()
    clearTimeout(entry.timer)
    // The Browser surface is never idle as a whole; its tabs are swept one by one.
    if (chatId === BROWSER_HOME_SESSION_ID) return
    const delay = this.agentUse.has(chatId) ? this.inactivityMs : Math.min(this.inactivityMs, this.lifecycle.settledMs)
    entry.timer = setTimeout(() => {
      const current = this.sessions.get(chatId)
      if (current !== entry || Date.now() - entry.touchedAt < delay) return
      // A session someone is looking at or listening to is not idle, whatever the
      // clock says. Losing the open page out from under a reader is the one sweep
      // nobody would forgive.
      if (this.inUse(chatId, entry)) {
        this.touch(chatId, entry)
        return
      }
      void this.sleep(chatId)
    }, delay)
    entry.timer.unref?.()
  }

  /** On screen, on its way there (a `show` still in flight), previewed or audible. */
  private inUse(chatId: string, entry: SessionEntry): boolean {
    return this.visibleId === chatId || this.visibleIntent?.chatId === chatId || this.previewIntent?.chatId === chatId ||
      entry.host.hasPreviewWindow() || entry.host.audible()
  }

  private readonly marks = {
    record: (url: string, favicon: string) => {
      try { this.browserHistory.recordFavicon(url, favicon) }
      catch (error: unknown) { console.warn('[manor] browser favicon write failed', error instanceof Error ? error.message : String(error)) }
    },
    lookup: (url: string) => {
      try { return this.browserHistory.favicon(url) }
      catch { return undefined }
    },
  }

  private async sequence(step: () => Promise<void>): Promise<void> {
    const task = this.visibility.then(step)
    this.visibility = task.catch(() => undefined)
    await task
  }

  /**
   * One live host operation. Several chats may run at once; a profile clear waits
   * until they all leave, and a new one waits until that clear has finished.
   * Page-context selection stays a reader on purpose: an arriving `act` must still
   * be able to cancel it, which a single exclusive lock would block forever.
   */
  private async withHost<T>(work: () => Promise<T>): Promise<T> {
    // No await on the free path. Yielding here lets a clear sneak in before
    // `inflight` rises, which is the race this lock exists to close.
    while (this.clearWaiters > 0) await this.clearLock
    if (this.inflight === 0) {
      this.idle = new Promise<void>((resolve) => {
        this.resolveIdle = resolve
      })
    }
    this.inflight += 1
    try {
      return await work()
    } finally {
      this.inflight -= 1
      if (this.inflight === 0) this.resolveIdle()
    }
  }

  /** Exclusive owner of the profile. No live renderer exists across this call. */
  private async withClear<T>(work: () => Promise<T>): Promise<T> {
    this.clearWaiters += 1
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.clearLock
    this.clearLock = previous.then(() => held)
    await previous
    try {
      if (this.inflight > 0) await this.idle
      return await work()
    } finally {
      this.clearWaiters -= 1
      release()
    }
  }

  /** Closes an idle session unless it came back into use while this waited for the host. */
  private async sleep(chatId: string): Promise<void> {
    await this.withHost(async () => {
      const entry = this.sessions.get(chatId)
      if (entry === undefined || this.inUse(chatId, entry)) return
      await this.closeSession(chatId, false)
    })
  }

  private capture(chatId: string, host: BrowserHost): void {
    const state = host.state()
    const urls = state.tabs.map((tab) => this.storableUrl(tab.url))
    if (urls.length === 0) {
      if (this.persisted.delete(chatId)) this.flush()
      return
    }
    const found = state.tabs.findIndex((tab) => tab.id === state.activeTabId)
    const pinnedCount = state.tabs.filter((tab) => tab.pinned === true).length
    this.persisted.set(chatId, { urls, activeIndex: found === -1 ? 0 : found,
      ...(pinnedCount > 0 ? { pinnedCount } : {}) })
    this.flush()
  }

  private forget(chatId: string): void {
    if (!this.persisted.delete(chatId)) return
    this.flush()
  }

  private forgetAll(): void {
    if (this.persisted.size === 0) return
    this.persisted.clear()
    this.flush()
  }

  private flush(): void {
    try {
      this.saveTabs(this.persisted)
    } catch (error: unknown) {
      console.warn(
        '[manor] could not persist DM browser tabs',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

function idleTimer(): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {}, 0)
  clearTimeout(timer)
  return timer
}
