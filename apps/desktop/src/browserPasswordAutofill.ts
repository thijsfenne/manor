import { randomUUID } from 'node:crypto'
import type { BrowserLoginLookup, BrowserPasswordOfferChoice, BrowserTabPasswords } from '@manor/contracts'
import type { IpcMain, IpcMainEvent, WebContents } from 'electron'
import { loginOrigin, type BrowserPasswordStore } from './browserPasswords'

/** Copied into `browserGuestPreload.ts`, which cannot import this module. */
export const PASSWORD_CAPTURE_CHANNEL = 'manor:browser-password:capture'
export const PASSWORD_FILL_CHANNEL = 'manor:browser-password:fill'
/** The guest's answer to an agent-requested probe or fill: whether a password field took it. */
export const PASSWORD_FILLED_CHANNEL = 'manor:browser-password:filled'

/** An unanswered offer, and the username step of a two-page login, stop mattering after this. */
const PENDING_MS = 5 * 60_000
/** How long the page's guest script gets to answer a probe or an agent fill. */
const GUEST_ANSWER_MS = 3_000

/** An agent's view of the login it asked to fill; the host adds the tab. The password never appears here. */
export type AgentLoginLookup = Omit<BrowserLoginLookup, 'tabId'>

/** What a filled password reads as in anything handed to an agent. */
const REDACTED = '••••••••'
/** Identities and binary data, never page text: rewriting them would break routing or an image. */
const UNREDACTED_KEYS = new Set(['id', 'chatId', 'activeTabId', 'favicon', 'screenshot', 'passwords'])
/**
 * Shorter passwords cannot be blanked from page output without blanking ordinary text,
 * so an agent's request to fill one is refused and the user signs in themself.
 */
const MIN_AGENT_FILL_LENGTH = 4
const SEALED_PAGE_LOGIN = 'This page received a secret, so a saved login cannot be filled here. Go to a new address first.'

/**
 * What a tab needs from saved passwords. The tab registers its page and any sign-in
 * popup; the strip reads `state`; only the user's clicks reach `fill` and `answer`.
 */
export interface PagePasswords {
  watch(tabId: string, contents: WebContents, changed: () => void): void
  state(tabId: string, url: string): BrowserTabPasswords | undefined
  fill(contents: WebContents, loginId: string): void
  answer(tabId: string, choice: BrowserPasswordOfferChoice): void
  forget(tabId: string): void
  /** An agent's request, before the card: which saved login this page's exact origin has. */
  agentLookup(contents: WebContents, username?: string): Promise<AgentLoginLookup>
  /** After the user clicked Fill on the card: only into this page and origin, only into a real password field. */
  agentFill(contents: WebContents, target: { pageId: number; origin: string; loginId: string }): Promise<{ username: string }>
  /** The document and password field a secret card would fill. */
  agentField(contents: WebContents): Promise<AgentLoginLookup>
  /** After the user submitted a secret card: into that exact document, and the page is sealed from then on. */
  agentFillSecret(contents: WebContents, target: { pageId: number; origin: string; value: string }, opener?: WebContents): Promise<void>
  /** Whether agents, history and the session file are kept off this page, because it took a secret. */
  sealed(contents: WebContents): boolean
  /** The only address a sealed page shows: its own from before the fill, since any later one, host included, could spell the value. */
  sealedOrigin(contents: WebContents): string | undefined
  /** The tab went to an address someone chose: what loads now did not come from the secret's form. */
  unseal(contents: WebContents): void
  /** Blanks every password filled this run from page output an agent reads: text, console, URLs, titles. */
  redact<T>(value: T): T
  /** Whether this page received a saved password and has not loaded a clean address since. */
  holds(contents: WebContents): boolean
  /** How many passwords this page ever received, so a capture can tell one landed while it ran. */
  fillsInto(contents: WebContents): number
}

const unavailable = (): never => { throw new Error('Saved passwords are not available.') }

export const noPagePasswords: PagePasswords = {
  watch: () => {},
  state: () => undefined,
  fill: unavailable,
  answer: () => {},
  forget: () => {},
  agentLookup: async () => unavailable(),
  agentFill: async () => unavailable(),
  agentField: async () => unavailable(),
  agentFillSecret: async () => unavailable(),
  sealed: () => false,
  sealedOrigin: () => undefined,
  unseal: () => {},
  redact: (value) => value,
  holds: () => false,
  fillsInto: () => 0,
}

interface PendingLogin {
  kind: 'save' | 'update'
  origin: string
  username: string
  password: string
  at: number
}

/**
 * Turns submitted logins into save offers and saved logins into fills. The password
 * of an offer lives only in this process until the user answers it or it expires. An
 * agent reaches only `agentLookup`, and `agentFill` once the user clicked Fill on its
 * card; both answer with the origin and username, never the password.
 */
export class PasswordAutofill implements PagePasswords {
  private readonly pages = new Map<number, { tabId: string; changed: () => void }>()
  private readonly offers = new Map<string, PendingLogin>()
  private readonly expiries = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly usernames = new Map<string, { origin: string; username: string; at: number }>()
  private readonly guestAnswers = new Map<string, { contents: WebContents; settle: (filled: boolean) => void }>()
  /** Every password filled into a page this run, as the page could echo it: raw, URL- or form-encoded. */
  private readonly filled = new Set<string>()
  /**
   * Pages that took a secret card's value. Manor keeps no copy, so it cannot blank an
   * echo the way `filled` does: nothing an agent or the disk could read leaves these
   * pages instead, through the page's own redirects, until someone picks a new address.
   */
  private readonly sealedPages = new Map<number, string>()
  /** Renewed by every navigation, so a secret card fills only the document it showed. */
  private readonly documents = new WeakMap<WebContents, number>()
  private nextDocument = 1
  /** Pages that received a password, until they load a clean address: pixels there cannot be redacted. */
  private readonly holding = new Set<number>()
  private readonly fills = new WeakMap<WebContents, number>()

  constructor(
    private readonly store: BrowserPasswordStore,
    ipc: Pick<IpcMain, 'on'>,
    private readonly now: () => number = Date.now,
  ) {
    ipc.on(PASSWORD_CAPTURE_CHANNEL, (event, payload: unknown) => this.capture(event, payload))
    ipc.on(PASSWORD_FILLED_CHANNEL, (event, payload: unknown) => this.guestAnswered(event, payload))
  }

  watch(tabId: string, contents: WebContents, changed: () => void): void {
    const id = contents.id
    this.pages.set(id, { tabId, changed })
    contents.once('destroyed', () => {
      if (this.pages.get(id)?.tabId === tabId) this.pages.delete(id)
    })
  }

  state(tabId: string, url: string): BrowserTabPasswords | undefined {
    const offer = this.offer(tabId)
    const origin = loginOrigin(url)
    let logins: BrowserTabPasswords['logins'] = []
    if (origin !== null) {
      try {
        logins = this.store.forOrigin(origin).map(({ id, username }) => ({ id, username }))
      } catch (error: unknown) {
        console.warn('[manor] saved passwords lookup failed', messageOf(error))
      }
    }
    if (logins.length === 0 && offer === undefined) return undefined
    return {
      logins,
      ...(offer === undefined ? {} : { offer: { kind: offer.kind, origin: offer.origin, username: offer.username } }),
    }
  }

  /** Fills the page only while its own address is the login's site, checked at the moment of sending. */
  fill(contents: WebContents, loginId: string): void {
    const credential = this.store.credential(loginId)
    if (credential === null) throw new Error('This saved password no longer exists.')
    if (contents.isDestroyed() || loginOrigin(contents.mainFrame.url) !== credential.origin) {
      throw new Error('This password belongs to another site.')
    }
    this.remember(credential.password, contents)
    contents.mainFrame.send(PASSWORD_FILL_CHANNEL, { username: credential.username, password: credential.password })
  }

  async agentLookup(contents: WebContents, username?: string): Promise<AgentLoginLookup> {
    if (this.sealed(contents)) throw new Error(SEALED_PAGE_LOGIN)
    const origin = contents.isDestroyed() ? null : loginOrigin(contents.mainFrame.url)
    if (origin === null) throw new Error('This page is not a website Manor can fill a saved login into.')
    const logins = this.store.forOrigin(origin)
    const saved = username === undefined ? logins[0] : logins.find((login) => login.username === username)
    if (saved !== undefined) agentFillable(this.store.credential(saved.id)?.password ?? '')
    const passwordField = await this.askGuest(contents, { probe: true })
    return {
      pageId: contents.id,
      origin,
      ...(saved === undefined ? {} : { login: { id: saved.id, username: saved.username } }),
      passwordField,
    }
  }

  /**
   * The card's binding, checked again at the moment of filling: the page must still be
   * on the login's exact origin and must have a visible password field. The answer
   * names the username only.
   */
  async agentFill(contents: WebContents, target: { pageId: number; origin: string; loginId: string }): Promise<{ username: string }> {
    if (this.sealed(contents)) throw new Error(SEALED_PAGE_LOGIN)
    const credential = this.store.credential(target.loginId)
    if (credential === null || credential.origin !== target.origin) throw new Error('This saved login no longer exists, so nothing was filled.')
    if (contents.id !== target.pageId) throw new Error('The sign-in page was closed or replaced before Fill was clicked, so nothing was filled.')
    agentFillable(credential.password)
    const current = contents.isDestroyed() ? null : loginOrigin(contents.mainFrame.url)
    if (current !== credential.origin) {
      throw new Error(`The page moved from ${siteName(credential.origin)} to ${current === null ? 'another page' : siteName(current)} before Fill was clicked, so nothing was filled.`)
    }
    this.remember(credential.password, contents)
    const filled = await this.askGuest(contents, { username: credential.username, password: credential.password, agent: true })
    if (!filled) throw new Error('Manor could not fill the saved password into this page, so nothing was filled.')
    return { username: credential.username }
  }

  /** A sealed page may take a second card, the code after a password; it still names only its earlier origin. */
  async agentField(contents: WebContents): Promise<AgentLoginLookup> {
    const origin = this.sealedOrigin(contents) ?? (contents.isDestroyed() ? null : loginOrigin(contents.mainFrame.url))
    if (origin === null) throw new Error('This page is not a website Manor can fill.')
    return { pageId: this.documentOf(contents), origin, passwordField: await this.askGuest(contents, { probe: true }) }
  }

  async agentFillSecret(contents: WebContents, target: { pageId: number; origin: string; value: string }, opener?: WebContents): Promise<void> {
    if (this.documents.get(contents) !== target.pageId) throw new Error('The page changed while the card waited, so nothing was filled.')
    const current = contents.isDestroyed() ? null : loginOrigin(contents.mainFrame.url)
    if (current !== target.origin) throw new Error('The page moved to another site, so nothing was filled.')
    // Before the fill, and it stays after a failed one: silence does not prove the value missed.
    this.seal(contents)
    if (opener !== undefined) this.seal(opener)
    if (!await this.askGuest(contents, { username: '', password: target.value, agent: true })) {
      throw new Error('Manor could not fill this page, so nothing was filled.')
    }
  }

  sealed(contents: WebContents): boolean {
    return this.sealedPages.has(contents.id)
  }

  sealedOrigin(contents: WebContents): string | undefined {
    return this.sealedPages.get(contents.id)
  }

  unseal(contents: WebContents): void {
    this.sealedPages.delete(contents.id)
  }

  /** A failed save keeps the offer, so the strip's retry still has something to save. */
  answer(tabId: string, choice: BrowserPasswordOfferChoice): void {
    const offer = this.offer(tabId)
    if (offer !== undefined) {
      if (choice === 'save') this.store.save(offer.origin, offer.username, offer.password)
      if (choice === 'never') this.store.neverSave(offer.origin)
    }
    this.dropOffer(tabId)
    this.notify(tabId)
  }

  forget(tabId: string): void {
    this.dropOffer(tabId)
    this.usernames.delete(tabId)
  }

  private capture(event: IpcMainEvent, payload: unknown): void {
    const page = this.pages.get(event.sender.id)
    const frame = event.senderFrame
    if (page === undefined || frame === null || frame !== event.sender.mainFrame) return
    const origin = loginOrigin(frame.url)
    const login = readCapture(payload)
    if (origin === null || login === null) return
    // A sealed page may echo the value into any field, and a capture would hold it for minutes.
    if (this.sealedPages.has(event.sender.id)) return
    if (login.kind === 'username') {
      this.usernames.set(page.tabId, { origin, username: login.username, at: this.now() })
      return
    }
    const earlier = this.usernames.get(page.tabId)
    const username = login.username.trim() !== '' || earlier === undefined ||
      earlier.origin !== origin || this.now() - earlier.at > PENDING_MS
      ? login.username
      : earlier.username
    let kind: PendingLogin['kind'] | undefined
    try {
      kind = this.store.offerFor(origin, username, login.password)?.kind
    } catch {
      // An oversized or empty field is not a login worth offering.
      return
    }
    // The newest submission decides: a corrected password that is already stored
    // must not leave the earlier wrong one waiting behind Update.
    this.dropOffer(page.tabId)
    if (kind !== undefined) {
      const offer = { kind, origin, username: username.trim(), password: login.password, at: this.now() }
      this.offers.set(page.tabId, offer)
      const expiry = setTimeout(() => {
        if (this.offers.get(page.tabId) !== offer) return
        this.dropOffer(page.tabId)
        this.notify(page.tabId)
      }, PENDING_MS)
      expiry.unref?.()
      this.expiries.set(page.tabId, expiry)
    }
    page.changed()
  }

  redact<T>(value: T): T {
    return this.filled.size === 0 ? value : redactStrings(value, [...this.filled]) as T
  }

  holds(contents: WebContents): boolean {
    return this.holding.has(contents.id)
  }

  fillsInto(contents: WebContents): number {
    return this.fills.get(contents) ?? 0
  }

  /** As the page could echo it: raw, in an address (encodeURIComponent) and as a submitted form. */
  private remember(password: string, contents: WebContents): void {
    this.fills.set(contents, this.fillsInto(contents) + 1)
    const id = contents.id
    if (!this.holding.has(id)) {
      this.holding.add(id)
      const release = () => {
        this.holding.delete(id)
        contents.off('did-navigate', navigated)
        contents.off('destroyed', release)
      }
      // A GET form carries the password into the next address, and that page may show it.
      const navigated = (_event: unknown, url: string) => {
        if (this.redact(url) === url) release()
      }
      contents.on('did-navigate', navigated)
      contents.on('destroyed', release)
    }
    if (password.length < MIN_AGENT_FILL_LENGTH) return
    const form = new URLSearchParams({ password }).toString().slice('password='.length)
    for (const variant of [password, encodeURIComponent(password), form]) this.filled.add(variant)
  }

  private seal(contents: WebContents): void {
    this.fills.set(contents, this.fillsInto(contents) + 1)
    if (this.sealedPages.has(contents.id)) return
    const id = contents.id
    this.sealedPages.set(id, loginOrigin(contents.mainFrame.url) ?? 'about:blank')
    contents.once('destroyed', () => this.sealedPages.delete(id))
  }

  private documentOf(contents: WebContents): number {
    const known = this.documents.get(contents)
    if (known !== undefined) return known
    const renew = () => {
      this.documents.set(contents, this.nextDocument)
      this.nextDocument += 1
    }
    contents.on('did-navigate', renew)
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) renew()
    })
    renew()
    return this.documents.get(contents) ?? 0
  }

  /** Sends one request to the page's guest script and waits for its yes or no; silence is no. */
  private askGuest(contents: WebContents, payload: Record<string, unknown>): Promise<boolean> {
    const requestId = randomUUID()
    return new Promise<boolean>((resolve) => {
      const settle = (filled: boolean) => {
        clearTimeout(timer)
        this.guestAnswers.delete(requestId)
        resolve(filled)
      }
      const timer = setTimeout(() => settle(false), GUEST_ANSWER_MS)
      timer.unref?.()
      this.guestAnswers.set(requestId, { contents, settle })
      try {
        contents.mainFrame.send(PASSWORD_FILL_CHANNEL, { ...payload, requestId })
      } catch {
        settle(false)
      }
    })
  }

  private guestAnswered(event: IpcMainEvent, payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return
    const { requestId, filled } = payload as Record<string, unknown>
    const waiting = typeof requestId === 'string' ? this.guestAnswers.get(requestId) : undefined
    // Only the page the request went to may answer it, from its main frame.
    if (waiting === undefined || event.sender !== waiting.contents || event.senderFrame !== event.sender.mainFrame) return
    waiting.settle(filled === true)
  }

  private offer(tabId: string): PendingLogin | undefined {
    const offer = this.offers.get(tabId)
    if (offer !== undefined && this.now() - offer.at > PENDING_MS) {
      this.dropOffer(tabId)
      return undefined
    }
    return offer
  }

  private dropOffer(tabId: string): void {
    this.offers.delete(tabId)
    clearTimeout(this.expiries.get(tabId))
    this.expiries.delete(tabId)
  }

  private notify(tabId: string): void {
    for (const page of this.pages.values()) {
      if (page.tabId === tabId) {
        page.changed()
        return
      }
    }
  }
}

function readCapture(payload: unknown):
  | { kind: 'login'; username: string; password: string }
  | { kind: 'username'; username: string }
  | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { kind, username, password } = payload as Record<string, unknown>
  if (typeof username !== 'string' || username.length > 500) return null
  if (kind === 'username') return username.trim() === '' ? null : { kind, username }
  if (kind !== 'login' || typeof password !== 'string' || password === '') return null
  return { kind, username, password }
}

function agentFillable(password: string): void {
  if (password.length < MIN_AGENT_FILL_LENGTH) {
    throw new Error('This saved password is too short to keep out of an agent\'s view, so Manor does not fill it on request. Ask the user to sign in themselves.')
  }
}

function redactStrings(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.replaceAll(secret, REDACTED), value)
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, secrets))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, UNREDACTED_KEYS.has(key) ? item : redactStrings(item, secrets)]))
  }
  return value
}

/** "github.com", or "127.0.0.1:4321" when the port is not the scheme's default. */
function siteName(origin: string): string {
  return new URL(origin).host
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
