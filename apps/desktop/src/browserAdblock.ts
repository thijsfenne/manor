import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserTabAdblock } from '@manor/contracts'
import type {
  CallbackResponse,
  HeadersReceivedResponse,
  IpcMain,
  IpcMainInvokeEvent,
  OnBeforeRequestListenerDetails,
  OnHeadersReceivedListenerDetails,
  Session,
  WebContents,
} from 'electron'

/** The channels the Ghostery frame preload invokes; its handlers live here so one engine serves any profile. */
const COSMETICS_CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters'
const MUTATION_OBSERVER_CHANNEL = '@ghostery/adblocker/is-mutation-observer-enabled'
/** Lists older than this are rebuilt in the background; until then the cache serves. */
const STALE_MS = 24 * 60 * 60_000
/** How often a running app checks staleness, which is also the retry delay after a failed refresh. */
const CHECK_MS = 60 * 60_000
/** A busy page blocks dozens of requests a second; the strip hears about it at most this often. */
const COUNT_PUBLISH_MS = 500
export const ADBLOCK_ENGINE_FILE = 'engine.bin'
const CSP_HEADER = 'content-security-policy'

/** The part of Ghostery's `ElectronBlocker` Manor calls. */
export interface AdblockEngine {
  onBeforeRequest(details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void): void
  onHeadersReceived(details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void): void
  onInjectCosmeticFilters(event: IpcMainInvokeEvent, url: string, msg?: never): Promise<void>
  onIsMutationObserverEnabled(event: IpcMainInvokeEvent): Promise<boolean>
}

/** What a browser tab reads and reports about blocking on its page. */
export interface PageAdblock {
  watch(contents: WebContents, changed: () => void): void
  state(contents: WebContents | undefined, url: string): BrowserTabAdblock | undefined
  setSiteBlocking(url: string, blocking: boolean): void
}

export const noPageAdblock: PageAdblock = {
  watch: () => {},
  state: () => undefined,
  setSiteBlocking: () => { throw new Error('Ad blocking is not available.') },
}

export interface BrowserAdblockOptions {
  /** Holds the serialized engine and the per-site switch, both survive restarts. */
  directory: string
  ipcMain: Pick<IpcMain, 'handle'>
  contentsById(id: number): WebContents | undefined
  /** Fetches and parses the lists away from the main process and writes the engine to `file`. */
  buildEngine(file: string): Promise<void>
  loadEngine(bytes: Uint8Array): AdblockEngine
  preloadPath: string
  now?: () => number
  log?: (message: string) => void
}

/**
 * Ads and trackers blocked in the shared browser profile, by default and for agents
 * alike. Blocking is read-side: it cancels requests and hides elements, and grants
 * nothing. The page never waits on lists: until an engine exists, requests pass.
 */
export class BrowserAdblock implements PageAdblock {
  private engine: AdblockEngine | null = null
  private building: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private session: { session: Session; preloadId: string } | null = null
  private readonly offHosts: Set<string>
  private readonly pages = new Map<number, { blocked: number; changed: () => void; pending: ReturnType<typeof setTimeout> | null }>()
  private readonly enginePath: string
  private readonly sitesPath: string
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(private readonly options: BrowserAdblockOptions) {
    this.enginePath = path.join(options.directory, ADBLOCK_ENGINE_FILE)
    this.sitesPath = path.join(options.directory, 'sites.json')
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((message) => console.warn(`[manor] ${message}`))
    this.offHosts = readOffHosts(this.sitesPath)
    options.ipcMain.handle(COSMETICS_CHANNEL, (event, url: unknown, msg: unknown) => {
      const engine = this.engineFor(event.sender)
      return engine === null || typeof url !== 'string' ? undefined : engine.onInjectCosmeticFilters(event, url, msg as never)
    })
    options.ipcMain.handle(MUTATION_OBSERVER_CHANNEL, (event) => {
      const engine = this.engineFor(event.sender)
      return engine === null ? false : engine.onIsMutationObserverEnabled(event)
    })
  }

  /** Loads the cached engine, then keeps it fresh. Never throws; a page loads either way. */
  async start(): Promise<void> {
    if (this.timer !== null) return
    this.timer = setInterval(() => { void this.refreshIfStale() }, CHECK_MS)
    this.timer.unref?.()
    await this.loadCached()
    await this.refreshIfStale()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** Blocks in this profile; a replaced profile is detached first, since the handlers are one per session. */
  attach(session: Session): void {
    if (this.session?.session === session) return
    this.detach()
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => this.beforeRequest(details, callback))
    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => this.headersReceived(details, callback))
    const preloadId = session.registerPreloadScript({ type: 'frame', filePath: this.options.preloadPath })
    this.session = { session, preloadId }
  }

  detach(): void {
    const attached = this.session
    if (attached === null) return
    this.session = null
    attached.session.webRequest.onBeforeRequest(null)
    attached.session.webRequest.onHeadersReceived(null)
    attached.session.unregisterPreloadScript(attached.preloadId)
  }

  watch(contents: WebContents, changed: () => void): void {
    const id = contents.id
    const previous = this.pages.get(id)?.pending
    if (previous != null) clearTimeout(previous)
    const page = { blocked: 0, changed, pending: null as ReturnType<typeof setTimeout> | null }
    this.pages.set(id, page)
    // A committed page starts at zero; a cancelled navigation or a download keeps the count.
    contents.on('did-navigate', () => {
      if (this.pages.get(id) !== page || page.blocked === 0) return
      page.blocked = 0
      changed()
    })
    contents.once('destroyed', () => {
      if (page.pending !== null) clearTimeout(page.pending)
      if (this.pages.get(id) === page) this.pages.delete(id)
    })
  }

  state(contents: WebContents | undefined, url: string): BrowserTabAdblock | undefined {
    const host = webHost(url)
    if (host === null) return undefined
    const blocked = contents === undefined || contents.isDestroyed() ? 0 : this.pages.get(contents.id)?.blocked ?? 0
    return { blocking: !this.offHosts.has(host), blocked }
  }

  /** The per-site way out for logins and payments that break; persisted before it reports done. */
  setSiteBlocking(url: string, blocking: boolean): void {
    const host = webHost(url)
    if (host === null) throw new Error('Ad blocking can only be switched for a website.')
    if (blocking === !this.offHosts.has(host)) return
    const next = new Set(this.offHosts)
    if (blocking) next.delete(host)
    else next.add(host)
    writeAtomically(this.sitesPath, JSON.stringify({ off: [...next].sort() }, null, 2))
    if (blocking) this.offHosts.delete(host)
    else this.offHosts.add(host)
  }

  /** Rebuilds when the cache is missing or old. A failure keeps the engine already serving. */
  async refreshIfStale(): Promise<void> {
    if (this.building !== null) return this.building
    const modified = await stat(this.enginePath).then((info) => info.mtimeMs, () => null)
    if (this.engine !== null && modified !== null && this.now() - modified < STALE_MS) return
    this.building = (async () => {
      try {
        mkdirSync(this.options.directory, { recursive: true })
        await this.options.buildEngine(this.enginePath)
        await this.loadCached()
      } catch (error: unknown) {
        this.log(`Ad block lists could not refresh; ${this.engine === null ? 'blocking waits for the next try' : 'the cached lists stay in use'}. ${messageOf(error)}`)
      } finally {
        this.building = null
      }
    })()
    return this.building
  }

  private async loadCached(): Promise<void> {
    let bytes: Uint8Array
    try { bytes = await readFile(this.enginePath) } catch { return }
    try {
      this.engine = this.options.loadEngine(bytes)
    } catch (error: unknown) {
      // An engine serialized by another library version is rebuilt, not trusted.
      this.log(`Cached ad block engine is unreadable and will be rebuilt. ${messageOf(error)}`)
    }
  }

  private beforeRequest(details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void): void {
    const engine = this.engine
    if (engine === null || details.resourceType === 'mainFrame' || this.switchedOff(details)) return callback({})
    engine.onBeforeRequest(details, (response) => {
      if (response.cancel === true || response.redirectURL !== undefined) this.count(details.webContentsId)
      callback(response)
    })
  }

  private headersReceived(details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void): void {
    const engine = this.engine
    if (engine === null || this.switchedOff(details)) return callback({})
    // Ghostery folds the site's own policy into its filter policy, and a duplicate directive
    // in one policy is ignored, so a filter could loosen the site's CSP. Asked with no
    // headers it returns only the filter policy, which then rides as a separate policy.
    engine.onHeadersReceived({ ...details, responseHeaders: {} }, (response) => {
      const added = response.responseHeaders?.[CSP_HEADER]
      if (added === undefined || added.length === 0) return callback({})
      const headers = { ...details.responseHeaders }
      const name = Object.keys(headers).find((key) => key.toLowerCase() === CSP_HEADER) ?? CSP_HEADER
      headers[name] = [...headers[name] ?? [], ...added]
      callback({ responseHeaders: headers })
    })
  }

  /**
   * A site is judged by the page on screen, so its frames and scripts follow its switch.
   * A page's own response is judged by its address: until it commits, the contents still
   * name the page it replaces.
   */
  private switchedOff(details: { webContentsId?: number; url: string; referrer: string; resourceType: string }): boolean {
    if (this.offHosts.size === 0) return false
    const contents = details.webContentsId === undefined ? undefined : this.options.contentsById(details.webContentsId)
    const page = details.resourceType === 'mainFrame' ? details.url
      : contents !== undefined && !contents.isDestroyed() ? contents.getURL() : details.referrer
    const host = webHost(page)
    return host !== null && this.offHosts.has(host)
  }

  private engineFor(sender: WebContents): AdblockEngine | null {
    if (this.engine === null || this.session === null || sender.session !== this.session.session) return null
    const host = webHost(sender.getURL())
    return host !== null && this.offHosts.has(host) ? null : this.engine
  }

  private count(webContentsId: number | undefined): void {
    const page = webContentsId === undefined ? undefined : this.pages.get(webContentsId)
    if (page === undefined) return
    page.blocked += 1
    page.pending ??= setTimeout(() => { page.pending = null; page.changed() }, COUNT_PUBLISH_MS)
  }
}

/** The switch is per host, `www.` included, the way the address bar shows it. */
export function webHost(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

function readOffHosts(file: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const off = typeof parsed === 'object' && parsed !== null ? (parsed as { off?: unknown }).off : undefined
    return new Set(Array.isArray(off) ? off.filter((host): host is string => typeof host === 'string' && host !== '') : [])
  } catch {
    return new Set()
  }
}

function writeAtomically(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, contents)
  renameSync(temporary, file)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
