import {
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  CursorAddSelection01Icon,
  Globe02Icon,
  GlobeIcon,
  HistoryIcon,
  MonitorSmartphoneIcon,
  PictureInPictureOnIcon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  SearchAddIcon,
  SearchMinusIcon,
  Shield01Icon,
  ShieldOffIcon,
  StarIcon,
} from '@hugeicons/core-free-icons'
import { StarIcon as SolidStarIcon } from '@manor/client-runtime/solid-icons'
import { MAX_PAGE_CONTEXT_ATTACHMENTS } from '@manor/contracts'
import { AnimatePresence, motion, Reorder } from 'motion/react'
import { createPortal } from 'react-dom'
import type {
  BrowserSessionState,
  BrowserBookmark,
  BrowserDeviceViewport,
  BrowserAddressMatches,
  BrowserPasswordOfferChoice,
  BrowserSearchEngine,
  BrowserTabAdblock,
  BrowserTabState,
  DesktopBrowserBridge,
  BrowserImportStatus,
  ImportBrowserId,
  PageContextAttachment,
} from '@manor/contracts'
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { addressParts, resolveBrowserAddress, SEARCH_ENGINES, searchUrl, shownAddress } from '../browserAddress'
import { cleanTitle, matchSpan, planAddress, shownUrl, type AddressSuggestion } from '../browserSuggestions'
import type { CrossingTarget } from '../browserCrossing'
import { browserActorLabel, type BrowserActivity } from '../desktopBrowser'
import { EASE_TRAVEL, ICON_SWAP, ICON_SWAP_GONE, ICON_SWAP_REST, INSTANT, TAB_REORDER } from '../motion'
import { useBrowserSlot } from '../useBrowserSlot'
export { isPersistentBrowserProfileFailure } from '../useBrowserSlot'
import { ConfirmStrip } from './Confirm'
import { Icon } from './Icon'
import { DOCK_PANEL_SHELL, STAGE_PANEL_SHELL, dockPanelLayoutClass } from './ui/dockPanel'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Popover } from './ui/Popover'
import { ScrollFade } from './ui/ScrollFade'
import { useDismiss } from './ui/useDismiss'
import { usePopupPlacement, type PopupPlacement } from './ui/usePopupPlacement'
import { BrowserMenu, nextZoom } from './BrowserMenu'
import { BrowserFindBar } from './BrowserFindBar'
import { BrowserBookmarksMenu } from './BrowserBookmarksMenu'
import { BrowserPasswordOffer, BrowserPasswordsMenu, BrowserSavedPasswords } from './BrowserPasswords'
import { answerImportHint, BrowserImportCard, BrowserImportHint, importHintAnswered, importProfileLabel } from './BrowserImport'
import { BrowserDeviceToolbar, DESKTOP_VIEWPORT } from './BrowserDeviceToolbar'
import { BrowserLocalServers } from './BrowserLocalServers'
import { subscribePageSelection, takePageSelection } from '../browserPageSelection'

const EMPTY: BrowserSessionState['tabs'] = []
/** A tab missing from a drag's order (opened mid-drag) sorts after the ones it holds. */
const rankIn = (order: readonly string[], id: string) => {
  const index = order.indexOf(id)
  return index === -1 ? order.length : index
}
const TAB_ROW = 'scrollbar-hidden flex min-w-0 items-center gap-1'
const noop = () => {}
const HISTORY_SEARCH_DEBOUNCE_MS = 120
const NO_MATCHES: BrowserAddressMatches = { sites: [], pages: [] }
/** The resting site sliding into the full address. The field fades in over its last stretch. */
const ADDRESS_TRAVEL = { duration: 0.34, ease: EASE_TRAVEL }
const ADDRESS_HANDOVER = { duration: 0.08 }

function bookmarkableUrl(url: string | undefined): string | null {
  if (url === undefined || !/^https?:\/\//i.test(url)) return null
  try { return new URL(url).href } catch { return null }
}

export const browserStateForChat = (
  chatId: string,
  current: BrowserSessionState | null,
  next: BrowserSessionState,
): BrowserSessionState | null => next.chatId === chatId ? next : current

/** See `dockPanelLayoutClass`; this panel's docked width is its own custom property. */
export const browserPanelLayoutClass = (expanded: boolean, overlay = false): string =>
  dockPanelLayoutClass('w-[calc(var(--browser-width)-8px)]', expanded, overlay)

interface BrowserPanelProps {
  /** The chat whose session this panel shows. One session per chat, for its whole life. */
  chatId: string
  /** Absent outside the Electron shell, which is the state this panel has to say out loud. */
  bridge: DesktopBrowserBridge | undefined
  /** The agent holding the page right now, if one is. */
  activity: BrowserActivity | undefined
  /** Where words typed into the address bar are searched: the house setting, or its default until it has loaded. */
  searchEngine: BrowserSearchEngine
  /** False as soon as this panel yields its slot to the floating preview. */
  shown?: boolean
  /** The native host has one page slot; two open browser panels share it by focus. */
  pageVisible?: boolean
  /** True while the region is animating; the view waits rather than crossing the rail. */
  settling: boolean
  /** Changes when the panel's tile may have moved without resizing; see `useBrowserSlot`. */
  placeKey?: string
  /** Hands the current page to the real browser. Absent where this host has none. */
  onOpenExternal?: (url: string) => void
  /** Adds the deliberate quote to this chat's composer, without sending it. Absent where no composer sits beside the page. */
  onAddPageContext?: (context: PageContextAttachment) => void
  /** The draft cap is visible at the control that would otherwise silently do nothing. */
  pageContextCount?: number
  /**
   * The full-stage Browser place fills its column instead of docking beside a chat,
   * so the dock's width, resize, expand and close controls stay off.
   */
  stage?: boolean
  width?: number
  expanded?: boolean
  overlay?: boolean
  revealed?: boolean
  resizing?: boolean
  resizeProps?: ComponentPropsWithoutRef<'div'>
  onToggleExpanded?: () => void
  onClose?: () => void
  onFloat?: () => void
  /** Copies a page into the Browser tab set; the source tab stays. Given inside a chat. */
  onSendToBrowser?: (url: string) => Promise<void>
  /** Goes to the Browser place, offered once a page has landed there. */
  onOpenBrowser?: () => void
  /** Recent chats a Browser page can be copied into. Given on the Browser stage. */
  openInChatTargets?: readonly CrossingTarget[]
  onOpenInChat?: (chatId: string, url: string) => Promise<void>
  /** A control at the tab strip's far end, where the dock keeps expand and close. Only where no top bar holds it. */
  stageControl?: ReactNode
  /** The sidebar handle at the start of the full Browser strip when its sidebar is hidden. */
  stageLeadingControl?: ReactNode
}

/**
 * The shared browser chrome measures a slot for the persistent DOM webview.
 * The guest stays mounted in BrowserWebviewHost when this panel closes. The chrome
 * follows the host's pushed state because agents also navigate the same page.
 */
export function BrowserPanel({
  chatId,
  bridge,
  activity,
  searchEngine,
  shown = true,
  pageVisible = true,
  settling,
  placeKey,
  onOpenExternal,
  onAddPageContext,
  pageContextCount = 0,
  stage = false,
  width = 0,
  expanded = false,
  overlay = false,
  revealed = true,
  resizing = false,
  resizeProps,
  onToggleExpanded = noop,
  onClose,
  onFloat,
  onSendToBrowser,
  onOpenBrowser,
  openInChatTargets,
  onOpenInChat,
  stageControl,
  stageLeadingControl,
}: BrowserPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  // Set by New tab with the tabs that already existed; the first address field that mounts
  // for a tab outside that list is the new tab's and takes focus. Switching to an older
  // tab before the new one appears therefore never steals it.
  const focusNewTab = useRef<{ chatId: string; known: ReadonlySet<string> } | null>(null)
  const [session, setSession] = useState<BrowserSessionState | null>(null)
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[] | null>(null)
  const [bookmarkError, setBookmarkError] = useState<string | null>(null)
  const [bookmarkBusy, setBookmarkBusy] = useState(false)
  const bookmarkRequest = useRef(0)
  const [addressReset, setAddressReset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  /** The last page sent to Browser, so the confirmation can offer the way there. */
  const [sent, setSent] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)
  const [importSettingsOpen, setImportSettingsOpen] = useState(false)
  const [importStatus, setImportStatus] = useState<BrowserImportStatus | null>(null)
  const [importSyncing, setImportSyncing] = useState(false)
  const [hintAnswered, setHintAnswered] = useState(importHintAnswered)
  const [answering, setAnswering] = useState(false)
  const [adblockBusy, setAdblockBusy] = useState(false)
  /** The find bar belongs to one tab; `summon` counts ⌘F presses so a repeat refocuses it. */
  const [findBar, setFindBar] = useState<{ tabId: string; summon: number } | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [configuring, setConfiguring] = useState(false)

  const tabs = session?.chatId === chatId ? session.tabs : EMPTY
  // While a tab is dragged the strip follows the pointer's order; the host's own order
  // takes over again once the drop has landed there.
  const [dragOrder, setDragOrder] = useState<readonly string[] | null>(null)
  const dragOrderRef = useRef(dragOrder)
  dragOrderRef.current = dragOrder
  const pinnedGroup = useRef<HTMLDivElement>(null)
  const regularGroup = useRef<HTMLDivElement>(null)
  const shownTabs = dragOrder === null ? tabs : [...tabs].sort((left, right) =>
    rankIn(dragOrder, left.id) - rankIn(dragOrder, right.id))
  const pinnedTabs = shownTabs.filter((tab) => tab.pinned)
  const regularTabs = shownTabs.filter((tab) => !tab.pinned)
  const orderedTabs = [...pinnedTabs, ...regularTabs]
  const active = tabs.find((tab) => tab.id === session?.activeTabId)
  const pageUrl = bookmarkableUrl(active?.url)
  const canSelectPageContext = pageUrl !== null
  const deviceMode = active?.settings?.viewport != null && bridge?.configure !== undefined
  const saved = pageUrl !== null && bookmarks?.some((bookmark) => bookmark.url === pageUrl) === true
  // A fresh tab shows Manor's own page; the guest would only lay a white plate over it.
  const blank = active !== undefined && shownAddress(active.url) === ''
  // A browser opened without tabs offers the same page; a pick then opens it as the first tab.
  const localPage = pageVisible && bridge?.localServers !== undefined
    && (blank || (!settling && session?.chatId === chatId && tabs.length === 0))

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason))
  }, [])

  // The strip follows the host, never the other way round. A tab the agent opened,
  // a title that arrived late and a page that finished loading all land here.
  useEffect(() => {
    if (!bridge?.webviews) return
    const stop = bridge.onState((next) => setSession((current) => browserStateForChat(chatId, current, next)))
    void bridge.tabs(chatId).then(setSession, fail)
    return stop
  }, [bridge, chatId, fail])

  useEffect(() => {
    if (bridge?.browserImportStatus === undefined) return
    void bridge.browserImportStatus().then(setImportStatus, fail)
  }, [bridge, fail])

  const loadBookmarks = useCallback(() => {
    if (bridge?.bookmarks === undefined) return
    const request = ++bookmarkRequest.current
    setBookmarks(null)
    setBookmarkError(null)
    setBookmarkBusy(true)
    void bridge.bookmarks().then(
      (next) => { if (bookmarkRequest.current === request) setBookmarks(next) },
      (reason: unknown) => {
        if (bookmarkRequest.current === request) setBookmarkError(reason instanceof Error ? reason.message : String(reason))
      },
    ).finally(() => { if (bookmarkRequest.current === request) setBookmarkBusy(false) })
  }, [bridge])

  useEffect(() => {
    if (!shown || !revealed || !pageVisible) {
      setBookmarks(null)
      return
    }
    loadBookmarks()
    return () => { bookmarkRequest.current += 1 }
  }, [shown, revealed, pageVisible, loadBookmarks])

  useBrowserSlot({ bridge, chatId, frame: frameRef, active: shown && revealed && pageVisible, vacant: blank,
    presentation: 'sidebar', resetKey: importStatus?.enabled, placeKey, onError: fail })

  // Browser keys work in the stage and in a chat's panel alike. Only the panel whose
  // page is showing reports focus, or two panels would overwrite each other.
  const claimsKeys = shown && pageVisible
  useEffect(() => {
    if (!claimsKeys || !bridge?.setShortcutFocus) return
    const focus = (event: Event) => bridge.setShortcutFocus?.(panelRef.current?.contains(event.target as Node) === true)
    let pointerStartedInside = false
    const pointerDown = (event: Event) => {
      pointerStartedInside = panelRef.current?.contains(event.target as Node) === true
      focus(event)
    }
    const pointerUp = (event: Event) => {
      if (pointerStartedInside) focus(event)
      pointerStartedInside = false
    }
    const pointerCancel = () => { pointerStartedInside = false }
    const restore = () => bridge.setShortcutFocus?.(panelRef.current?.contains(document.activeElement) === true)
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('pointerup', pointerUp, true)
    document.addEventListener('pointercancel', pointerCancel, true)
    document.addEventListener('focusin', focus, true)
    window.addEventListener('blur', clear)
    window.addEventListener('focus', restore)
    function clear() { bridge?.setShortcutFocus?.(false) }
    restore()
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('pointerup', pointerUp, true)
      document.removeEventListener('pointercancel', pointerCancel, true)
      document.removeEventListener('focusin', focus, true)
      window.removeEventListener('blur', clear)
      window.removeEventListener('focus', restore)
      clear()
    }
  }, [claimsKeys, bridge])

  const actor = browserActorLabel(activity)
  const locked = !bridge?.webviews || actor !== null || selecting || configuring
  const run = useCallback((action: () => Promise<unknown>) => {
    setError(null)
    setSent(false)
    void action().catch(fail)
  }, [fail])

  const cancelSignIn = bridge?.cancelSignIn?.bind(bridge)
  const fillPassword = bridge?.fillPassword?.bind(bridge)
  const answerOffer = bridge?.answerPasswordOffer?.bind(bridge)
  // Shown on the address row, or on the sign-in bar while a sign-in popup is open.
  const passwordsMenu = fillPassword === undefined || !active?.passwords?.logins.length ? null : (
    <BrowserPasswordsMenu logins={active.passwords.logins} disabled={locked}
      onFill={(loginId) => run(() => fillPassword(chatId, loginId))}
      onManage={() => setImportSettingsOpen(true)} />
  )
  // The way out when blocking breaks a login or payment. Like the passwords menu it acts on
  // the page on screen, so it rides on the sign-in bar while a sign-in popup is open.
  const setSiteAdblock = bridge?.setSiteAdblock?.bind(bridge)
  const adblock = active?.adblock
  const adblockUrl = active?.signIn?.url ?? pageUrl
  const adblockSwitch = setSiteAdblock === undefined || adblock === undefined || adblockUrl == null ? null : (
    <IconButton icon={adblock.blocking ? Shield01Icon : ShieldOffIcon} swapKey={adblock.blocking ? 'on' : 'off'}
      iconSize={14} size={24} label={adblockLabel(adblock, adblockUrl)} aria-pressed={adblock.blocking}
      disabled={locked || adblockBusy}
      onClick={() => {
        setAdblockBusy(true)
        run(() => setSiteAdblock(chatId, !adblock.blocking).finally(() => setAdblockBusy(false)))
      }} />
  )
  const answerPasswordOffer = (tabId: string, choice: BrowserPasswordOfferChoice) => {
    if (answerOffer === undefined) return
    setAnswering(true)
    run(() => answerOffer(chatId, tabId, choice).finally(() => setAnswering(false)))
  }

  const navigate = (url: string) => {
    if (bridge === undefined) return
    run(() => active === undefined ? bridge.newTab(chatId, url) : bridge.navigate(url, chatId))
  }
  const otherTabs = useMemo(() => tabs.filter((tab) => tab.id !== active?.id), [tabs, active?.id])
  const selectTab = (tabId: string) => {
    if (bridge !== undefined) run(() => bridge.tabs(chatId, tabId))
  }

  const openNewTab = (browser: DesktopBrowserBridge) => {
    const pending = { chatId, known: new Set(tabs.map((tab) => tab.id)) }
    focusNewTab.current = pending
    run(() => browser.newTab(chatId).catch((reason: unknown) => {
      if (focusNewTab.current === pending) focusNewTab.current = null
      throw reason
    }))
  }

  const consumeFocus = (tabId: string | undefined) => {
    const pending = focusNewTab.current
    if (pending === null || tabId === undefined || pending.chatId !== chatId || pending.known.has(tabId)) return false
    focusNewTab.current = null
    return true
  }

  const findBridge = bridge?.findInPage === undefined || bridge.stopFind === undefined ? undefined
    : { findInPage: bridge.findInPage.bind(bridge), stopFind: bridge.stopFind.bind(bridge) }
  const openFind = findBridge === undefined || active === undefined ? undefined
    : () => setFindBar((current) => ({ tabId: active.id, summon: (current?.summon ?? 0) + 1 }))
  useEffect(() => { setFindBar(null) }, [chatId, active?.id])

  const zoom = active?.settings?.zoomFactor ?? 1
  const setZoom = (zoomFactor: number) => {
    if (bridge?.configure === undefined || active === undefined || zoomFactor === zoom) return
    run(() => bridge.configure!(chatId, { zoomFactor }))
  }

  const toggleBookmark = () => {
    if (bridge?.toggleBookmark === undefined || active === undefined || pageUrl === null || bookmarkBusy || bookmarks === null) return
    const request = ++bookmarkRequest.current
    setBookmarkBusy(true)
    setBookmarkError(null)
    void bridge.toggleBookmark(pageUrl, active.title).then(
      (next) => { if (bookmarkRequest.current === request) setBookmarks(next) },
      (reason: unknown) => {
        if (bookmarkRequest.current === request) setBookmarkError(reason instanceof Error ? reason.message : String(reason))
      },
    ).finally(() => { if (bookmarkRequest.current === request) setBookmarkBusy(false) })
  }

  useEffect(() => {
    if (!claimsKeys || bridge?.onShortcut === undefined) return
    return bridge.onShortcut((shortcut) => {
      if (shortcut === 'focus-address') {
        if (!locked) { addressRef.current?.focus(); addressRef.current?.select() }
        return
      }
      if (locked) return
      switch (shortcut) {
        case 'new-tab': openNewTab(bridge); break
        case 'close-tab': if (active) run(() => bridge.closeTab(active.id, chatId)); break
        case 'reload': if (active) run(() => bridge.reload(chatId)); break
        case 'toggle-bookmark': toggleBookmark(); break
        case 'find': openFind?.(); break
        case 'reopen-tab': if (bridge.reopenClosedTab) run(() => bridge.reopenClosedTab!(chatId)); break
        case 'zoom-in': setZoom(nextZoom(zoom, 1)); break
        case 'zoom-out': setZoom(nextZoom(zoom, -1)); break
        case 'zoom-reset': setZoom(1); break
        case 'back': if (active?.canGoBack) run(() => bridge.goBack(chatId)); break
        case 'forward': if (active?.canGoForward) run(() => bridge.goForward(chatId)); break
        case 'next-tab':
        case 'previous-tab': {
          if (orderedTabs.length < 2) break
          const current = orderedTabs.findIndex((tab) => tab.id === active?.id)
          const step = shortcut === 'next-tab' ? 1 : -1
          const next = orderedTabs[(current + step + orderedTabs.length) % orderedTabs.length]
          if (next) run(() => bridge.tabs(chatId, next.id))
          break
        }
      }
    })
  }, [claimsKeys, bridge, locked, chatId, active, tabs, run, bookmarkBusy, bookmarks, pageUrl, zoom])

  const setViewport = (viewport: BrowserDeviceViewport | null) => {
    if (bridge?.configure === undefined) return
    run(async () => {
      setConfiguring(true)
      try { await bridge.configure!(chatId, { viewport }) }
      finally { setConfiguring(false) }
    })
  }

  const clearBrowserData = () => {
    if (bridge === undefined || clearing || locked) return
    setError(null)
    setClearing(true)
    void bridge.clearData().then(
      () => {
        setSession(null)
        setAddressReset((current) => current + 1)
        setClearArmed(false)
        setClearing(false)
        void bridge.browserImportStatus?.().then(setImportStatus, () => undefined)
      },
      (reason: unknown) => {
        setClearing(false)
        fail(reason)
      },
    )
  }

  const setBrowserImport = (enabled: boolean, browser: ImportBrowserId) => {
    if (bridge?.setBrowserImport === undefined || importSyncing) return
    answerImportHint()
    setHintAnswered(true)
    setError(null)
    setImportSyncing(true)
    void bridge.setBrowserImport(enabled, browser).then(
      (status) => {
        setSession(null)
        setAddressReset((current) => current + 1)
        setImportStatus(status)
        setImportSyncing(false)
      },
      (reason: unknown) => {
        setImportSyncing(false)
        fail(reason)
        void bridge.browserImportStatus?.().then(setImportStatus, () => undefined)
      },
    )
  }

  const canStartSelection = bridge !== undefined && onAddPageContext !== undefined && actor === null && !selecting
    && canSelectPageContext && pageContextCount < MAX_PAGE_CONTEXT_ATTACHMENTS
  const selectPageContext = () => {
    if (bridge === undefined || onAddPageContext === undefined || !canStartSelection) return
    setError(null)
    setSelecting(true)
    void bridge.selectPageContext(chatId).then(
      (context) => {
        setSelecting(false)
        if (context !== null) onAddPageContext(context)
      },
      (reason: unknown) => {
        setSelecting(false)
        fail(reason)
      },
    )
  }

  // A delivered page's Select opened its page here; picking starts once that tab has
  // loaded, the panel shows it and a pick is allowed, so the overlay lands on the page
  // The user asked about. A request that cannot start yet waits until it can or lapses.
  const [, setSelectionAsked] = useState(0)
  useEffect(() => subscribePageSelection(() => setSelectionAsked((count) => count + 1)), [])
  useEffect(() => {
    if (active === undefined || active.loading === true || !shown || !revealed || !pageVisible || !canStartSelection) return
    if (takePageSelection(chatId, active.url)) selectPageContext()
  })

  const moveTab = (browser: DesktopBrowserBridge, tabId: string, index: number) => {
    if (browser.moveTab === undefined) return
    run(async () => {
      try {
        const next = await browser.moveTab!(tabId, chatId, index)
        setSession((current) => browserStateForChat(chatId, current, next))
      } finally {
        setDragOrder(null)
      }
    })
  }

  const dropTab = (browser: DesktopBrowserBridge, tabId: string) => {
    const order = dragOrderRef.current
    const index = order?.indexOf(tabId) ?? -1
    if (order === null || index === -1 || index === tabs.findIndex((tab) => tab.id === tabId)) {
      setDragOrder(null)
      return
    }
    moveTab(browser, tabId, index)
  }

  const drawTab = (tab: BrowserTabState, browser: DesktopBrowserBridge, group: readonly BrowserTabState[]) => {
    const at = group.indexOf(tab)
    const offset = tab.pinned ? 0 : pinnedTabs.length
    const step = (by: number) => () => moveTab(browser, tab.id, offset + at + by)
    const movable = browser.moveTab !== undefined
    return (
      <Tab key={tab.id} tab={tab} active={tab.id === session?.activeTabId} disabled={locked}
        onSelect={() => run(() => browser.tabs(chatId, tab.id))}
        onClose={() => run(() => browser.closeTab(tab.id, chatId))}
        onPin={browser.pinTab === undefined ? undefined : () => run(() => browser.pinTab!(tab.id, chatId, !tab.pinned))}
        onMoveLeft={movable && at > 0 ? step(-1) : undefined}
        onMoveRight={movable && at < group.length - 1 ? step(1) : undefined}
        reorder={movable ? {
          dragging: dragOrder !== null,
          bounds: tab.pinned ? pinnedGroup : regularGroup,
          onDrop: () => dropTab(browser, tab.id),
        } : undefined} />
    )
  }

  /** One group of the strip. Pins and ordinary tabs each reorder only among themselves. */
  const drawTabGroup = (group: readonly BrowserTabState[], browser: DesktopBrowserBridge) => {
    if (browser.moveTab === undefined) return group.map((tab) => drawTab(tab, browser, group))
    const pinned = group === pinnedTabs
    return (
      <Reorder.Group as="div" axis="x" values={group.map((tab) => tab.id)} ref={pinned ? pinnedGroup : regularGroup}
        className="flex min-w-0 flex-1 items-center gap-1"
        onReorder={(ids: string[]) => setDragOrder(pinned
          ? [...ids, ...regularTabs.map((tab) => tab.id)]
          : [...pinnedTabs.map((tab) => tab.id), ...ids])}>
        {group.map((tab) => drawTab(tab, browser, group))}
      </Reorder.Group>
    )
  }

  return (
    <aside
      ref={panelRef}
      style={stage ? undefined : { '--browser-width': `${width}px` } as CSSProperties}
      data-open={overlay ? revealed : undefined}
      className={`grid min-h-0 grid-rows-[auto_minmax(0,1fr)] ease-arrive ${stage
        ? `${STAGE_PANEL_SHELL} min-w-0`
        : `${DOCK_PANEL_SHELL} ${browserPanelLayoutClass(expanded, overlay)}`}`}
    >
      {expanded || resizeProps === undefined ? null : (
        <div
          {...resizeProps}
          className="group absolute inset-y-0 left-0 z-30 w-2 touch-none cursor-col-resize outline-none max-[760px]:hidden"
        >
          <div
            className={`pointer-events-none absolute inset-y-0 left-[3px] w-0.5 bg-primary transition-opacity duration-150 group-hover:opacity-40 group-focus-visible:opacity-60 ${
              resizing ? 'opacity-60' : 'opacity-0'
            }`}
          />
        </div>
      )}

      {/* Nothing in the chrome may paint outside the panel. At the narrow end a row
          that cannot fit would otherwise spill over the rail beside it, which is the
          one place a panel must never reach. No z-index here: raised, the whole chrome
          painted over the peeking sidebar and sliding rails. The history list clears
          the page layer by leaving for the body. */}
      {/* The rule under the chrome closes off the device toolbar; without one the page
          meets the address row directly, and a line there sits on the site's top edge. */}
      <div className={`relative min-w-0 ${deviceMode ? 'border-b border-line' : ''}`}>
        <div className={`flex min-w-0 items-center gap-1 ${stage && stageLeadingControl
          ? 'pr-2 pl-[calc(4px+var(--titlebar-inset))] pt-[var(--titlebar-row-pad)]'
          : 'px-2 pt-2'}`}>
          {stage ? stageLeadingControl : null}
          {bridge === undefined ? (
            <h2 className="min-w-0 flex-1 truncate px-2 text-label font-semibold text-text">Browser</h2>
          ) : (
            <>
              {/* Pins stay left while ordinary tabs scroll. If pins themselves fill
                  the strip, their own group can scroll without moving the other tabs.
                  Neither shows a bar: the edge fade says there is more. */}
              <div className="flex min-w-0 flex-1 items-center gap-1 [--fade-to:var(--color-surface)]">
                {pinnedTabs.length === 0 ? null : (
                  <ScrollFade label="Pinned tabs" className="max-w-[50%] min-w-0 flex-none"
                    scrollerClassName={TAB_ROW}>
                    {drawTabGroup(pinnedTabs, bridge)}
                  </ScrollFade>
                )}
                <ScrollFade label="Tabs" className="min-w-0 flex-1" scrollerClassName={TAB_ROW}>
                  {drawTabGroup(regularTabs, bridge)}
                </ScrollFade>
              </div>
              <IconButton
                icon={PlusSignIcon}
                label="New tab"
                disabled={locked}
                onClick={() => openNewTab(bridge)}
              />
              {/* The status sits in the chrome rather than over the page, because the
                  page is not ours to draw on and a badge on top of it would be the one
                  pixel the agent's own screenshot then contains. */}
              {actor === null ? null : (
                <span
                  aria-live="polite"
                  title={actor}
                  aria-label={actor}
                  className="flex flex-none items-center gap-1.5 rounded-chip bg-surface-2 px-2 py-1 text-meta text-muted"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span className="max-w-[92px] truncate">{activity?.agentName}</span>
                </span>
              )}
            </>
          )}
          {stage ? null : (
            <IconButton
              icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon}
              label={expanded ? 'Collapse browser panel' : 'Expand browser panel'}
              aria-expanded={expanded}
              disabled={locked}
              onClick={onToggleExpanded}
            />
          )}
          {onClose === undefined ? null : (
            <IconButton icon={Cancel01Icon} label="Close browser panel" onClick={onClose} />
          )}
          {stageControl}
        </div>

        {!clearArmed ? null : (
          <ConfirmStrip
            question="Clear history, browser data, and sign out everywhere?"
            confirmLabel={clearing ? 'Clearing…' : 'Clear'}
            onConfirm={clearBrowserData}
            onCancel={() => setClearArmed(false)}
          />
        )}

        {importSettingsOpen || hintAnswered || importStatus === null ? null : (
          <BrowserImportHint
            status={importStatus}
            onSetUp={() => setImportSettingsOpen(true)}
            onDismiss={() => { answerImportHint(); setHintAnswered(true) }}
          />
        )}

        {!importSettingsOpen || importStatus === null ? null : (
          <div className="border-t border-line px-4 py-3">
            <BrowserImportCard status={importStatus} syncing={importSyncing} onChange={setBrowserImport} />
            {bridge === undefined ? null : <BrowserSavedPasswords bridge={bridge} />}
          </div>
        )}

        {bridge === undefined ? null : active?.signIn !== undefined ? (
          <BrowserSignInBar
            key={`sign-in:${chatId}:${active.id}`}
            url={active.signIn.url}
            passwords={passwordsMenu}
            adblock={adblockSwitch}
            onCancel={cancelSignIn === undefined ? undefined : () => run(() => cancelSignIn(active.id, chatId))}
          />
        ) : (
          <div className="flex min-w-0 items-center gap-0.5 px-2 py-2">
            <IconButton
              icon={ArrowLeft01Icon}
              label="Back"
              disabled={locked || active?.canGoBack !== true}
              onClick={() => run(() => bridge.goBack(chatId))}
            />
            <IconButton
              icon={ArrowRight01Icon}
              label="Forward"
              disabled={locked || active?.canGoForward !== true}
              onClick={() => run(() => bridge.goForward(chatId))}
            />
            <IconButton
              icon={active?.loading === true ? Cancel01Icon : RefreshIcon}
              label={active?.loading === true ? 'Stop loading' : 'Reload'}
              disabled={locked || active === undefined}
              onClick={() => run(() =>
                active?.loading === true ? bridge.stopLoading(chatId) : bridge.reload(chatId))}
            />
            {/* Page actions live on this row, next to the address they act on, so the
                tab strip only holds tabs, new tab, and the panel's own expand and close. */}
            {onAddPageContext === undefined ? null : <IconButton
              icon={CursorAddSelection01Icon}
              label={
                pageContextCount >= MAX_PAGE_CONTEXT_ATTACHMENTS
                  ? `Up to ${MAX_PAGE_CONTEXT_ATTACHMENTS} page contexts per message`
                  : selecting
                    ? 'Selecting page context. Press Escape to cancel.'
                    : 'Select page context'
              }
              selected={selecting}
              disabled={actor !== null || !canSelectPageContext || pageContextCount >= MAX_PAGE_CONTEXT_ATTACHMENTS}
              aria-pressed={selecting}
              onClick={selectPageContext}
            />}
            <BrowserAddressField
              key={`${chatId}:${active?.id ?? 'empty'}:${addressReset}`}
              addressRef={addressRef}
              bridge={bridge}
              url={active?.url ?? ''}
              locked={locked}
              consumeFocus={() => consumeFocus(active?.id)}
              otherTabs={otherTabs}
              onSelectTab={selectTab}
              onNavigate={navigate}
              onError={fail}
              searchEngine={searchEngine}
              trailingButtons={1 + (passwordsMenu === null ? 0 : 1) + (adblockSwitch === null ? 0 : 1) + (zoom === 1 ? 0 : 1)}
              trailing={<>
                {zoom === 1 ? null : (
                  <IconButton icon={zoom > 1 ? SearchAddIcon : SearchMinusIcon} iconSize={14} size={24}
                    label={`Page zoom ${Math.round(zoom * 100)}%. Reset to 100%`} title={`${Math.round(zoom * 100)}%`}
                    disabled={locked || bridge.configure === undefined} onClick={() => setZoom(1)} />
                )}
                {passwordsMenu}
                {adblockSwitch}
                <IconButton icon={saved ? SolidStarIcon : StarIcon} solid={saved} iconSize={14} size={24}
                  label={bridge.toggleBookmark === undefined ? 'Update the desktop app for bookmarks' : saved ? 'Remove bookmark' : 'Save bookmark'}
                  aria-pressed={saved}
                  disabled={locked || pageUrl === null || bookmarkBusy || bookmarks === null || bridge.toggleBookmark === undefined}
                  onClick={toggleBookmark} />
              </>}
            />
            <BrowserBookmarksMenu bookmarks={bookmarks} loading={bookmarkBusy && bookmarks === null}
              error={bookmarkError} disabled={locked || bridge.bookmarks === undefined}
              onRetry={loadBookmarks} onOpen={navigate} />
            <IconButton icon={MonitorSmartphoneIcon}
              label={bridge.configure === undefined ? 'Update the desktop app for the device toolbar'
                : active?.settings?.viewport ? 'Hide device toolbar' : 'Show device toolbar'}
              selected={active?.settings?.viewport != null}
              aria-pressed={active?.settings?.viewport != null}
              disabled={locked || active === undefined || bridge.configure === undefined}
              onClick={() => setViewport(active?.settings?.viewport ? null : DESKTOP_VIEWPORT)} />
            {stage ? null : <IconButton icon={PictureInPictureOnIcon} label="Float preview over chat"
              disabled={selecting || configuring || active === undefined || !onFloat || !bridge.webviews || !bridge.startPreview || !bridge.stopPreview || !bridge.onPreview}
              onClick={onFloat} />}
            <BrowserMenu key={`${chatId}:${active?.id ?? 'empty'}`} bridge={bridge} chatId={chatId}
              settings={active?.settings} disabled={locked} pageDisabled={active === undefined}
              settingsOpen={importSettingsOpen} settingsDisabled={importSyncing || importStatus === null}
              clearDisabled={clearing} onSettings={() => setImportSettingsOpen((open) => !open)}
              onClearData={() => setClearArmed(true)}
              {...(openFind === undefined ? {} : { onFind: openFind })}
              {...(onSendToBrowser === undefined || !canSelectPageContext || active === undefined ? {} : {
                onSendToBrowser: async () => { await onSendToBrowser(active.url); setSent(true) },
              })}
              {...(onOpenInChat === undefined || !canSelectPageContext || active === undefined ? {} : {
                openInChat: { targets: openInChatTargets ?? [], onOpen: (target: string) => onOpenInChat(target, active.url) },
              })}
              profile={importProfileLabel(importStatus)}
              {...(onOpenExternal === undefined || !canSelectPageContext || active === undefined ? {} : {
                onOpenExternal: () => onOpenExternal(active.url),
              })}
              onError={fail} onStart={() => { setError(null); setSent(false) }} />
          </div>
        )}

        {bridge?.answerPasswordOffer === undefined || active?.passwords?.offer === undefined ? null : (
          <BrowserPasswordOffer key={`${chatId}:${active.id}`} offer={active.passwords.offer} busy={answering}
            onAnswer={(choice) => answerPasswordOffer(active.id, choice)} />
        )}

        {findBridge === undefined || findBar === null || findBar.tabId !== active?.id ? null : (
          <BrowserFindBar key={`find:${chatId}:${active.id}`} bridge={findBridge} chatId={chatId}
            page={active.signIn === undefined ? `page ${active.url}` : `sign-in ${active.signIn.url}`}
            loading={active.signIn === undefined ? active.loading : active.signIn.loading === true}
            summon={findBar.summon} onClose={() => setFindBar(null)} />
        )}

        {deviceMode && active?.settings?.viewport ? (
          <BrowserDeviceToolbar key={`${chatId}:${active.id}`} viewport={active.settings.viewport}
            disabled={locked} onError={fail} onChange={setViewport} />
        ) : null}

        {selecting ? (
          <p className="m-0 px-4 pb-2.5 text-[12px] leading-relaxed text-dim">
            Select text or click an element. Press Escape to cancel.
          </p>
        ) : error !== null || bookmarkError !== null ? (
          <p className="m-0 px-4 pb-2.5 text-[12px] leading-relaxed text-danger">{error ?? bookmarkError}</p>
        ) : !sent ? null : (
          <p role="status" className="m-0 flex items-center gap-1 px-4 pb-2.5 text-[12px] leading-relaxed text-dim">
            Sent to Browser.
            {onOpenBrowser === undefined ? null : (
              <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-text underline-offset-2 hover:underline"
                onClick={onOpenBrowser}>Open Browser</button>
            )}
          </p>
        )}
      </div>

      {!bridge?.webviews ? (
        <div className="grid min-h-0 place-items-center px-8 text-center">
          <p className="m-0 text-label font-medium text-text">{bridge
            ? 'Update the desktop app to use the browser'
            : 'The shared browser needs the desktop app'}</p>
        </div>
      ) : (
        <div ref={frameRef} data-browser-slot="sidebar"
          // The stage's page runs to the column's edges; the guest takes this box's corners,
          // and the window's own where the two meet.
          className={`relative min-h-0 overflow-hidden bg-bg ${stage ? '' : 'mx-2 mb-2 rounded-lg'} ${deviceMode ? 'mt-2' : ''}`}>
          {localPage && bridge.localServers !== undefined ? (
            <BrowserLocalServers key={`${chatId}:${active?.id ?? ''}`} load={bridge.localServers} disabled={locked} onOpen={navigate} />
          ) : blank && pageVisible ? null : <p className="m-0 grid h-full place-items-center px-8 text-center text-meta leading-relaxed text-dim">
            {!pageVisible ? 'Focus this thread to show its browser.' : settling ? '' : tabs.length === 0
              ? 'No tabs open. Enter an address, or press the plus above.'
              : active?.loading ? 'Loading…' : ''}
          </p>}
        </div>
      )}
    </aside>
  )
}

/** Typing and suggestions update only this field, leaving the surrounding chrome idle. */
function BrowserAddressField({ addressRef, bridge, url, locked, consumeFocus, otherTabs, onSelectTab, onNavigate, onError, searchEngine, trailing, trailingButtons = 1 }: {
  addressRef: RefObject<HTMLInputElement>
  bridge: DesktopBrowserBridge
  url: string
  locked: boolean
  /** True once for the field of a tab just opened with New tab, so typing starts there. */
  consumeFocus(): boolean
  /** This thread's tabs other than the active one, offered when they match. */
  otherTabs: readonly BrowserTabState[]
  onSelectTab(tabId: string): void
  onNavigate(url: string): void
  onError(reason: unknown): void
  searchEngine: BrowserSearchEngine
  /** Sits inside the field at its end: the saved-passwords key, if any, and the bookmark star. */
  trailing?: ReactNode
  /** How many 24px buttons `trailing` holds, so the resting site label stops before them. */
  trailingButtons?: number
}) {
  const listId = useId()
  const historyRequest = useRef(0)
  // Older shells only search pages; the rows then find each site's root from those.
  const lookUp = bridge.addressMatches ?? (bridge.history === undefined ? undefined
    : (query: string) => bridge.history!(query).then((pages): BrowserAddressMatches => ({ sites: [], pages })))
  const [address, setAddress] = useState(shownAddress(url))
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [matches, setMatches] = useState<BrowserAddressMatches>(NO_MATCHES)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  // False after a deletion, so Backspace takes the completion away instead of bringing it straight back.
  const [completing, setCompleting] = useState(true)
  const [focused, setFocused] = useState(false)
  const plan = planAddress(historyQuery, matches, searchEngine, otherTabs, completing && address === historyQuery)
  const suggestions = plan.rows
  const form = useRef<HTMLFormElement>(null)
  const listOpen = historyOpen && !locked && lookUp !== undefined
  // The page is a native layer above the whole window, so a list drawn inside a raised
  // panel lands behind it. Portalled and fixed, like the menus, it clears the page.
  const listPlacement = usePopupPlacement({ open: listOpen, triggerRef: form, maxHeight: 320, minHeight: 160 })
  const list = useRef<HTMLDivElement>(null)
  // At rest the bar names only the site, centred. Focusing it slides the site to where
  // it sits in the full address while the rest fades in around it, then the real field
  // takes over; leaving runs the same move back. An edited address is not the page's
  // and just shows itself.
  const parts = addressParts(url)
  const site = parts !== null && address === shownAddress(url) ? parts : null
  const resting = site !== null && !focused
  const siteBox = useRef<HTMLSpanElement>(null)
  const siteText = useRef<HTMLSpanElement>(null)
  // How far the full address shifts to centre its site. `snap` is set by a measurement
  // (a resize, a new page) so the site jumps with the layout; only focus travels. Until
  // the first measurement the site stays hidden rather than flash at the left edge.
  const [siteShift, setSiteShift] = useState({ x: 0, snap: true, ready: false })
  useLayoutEffect(() => {
    const box = siteBox.current
    if (box === null) return
    const measure = () => {
      const text = siteText.current
      if (text === null) return
      const x = Math.max(0, (box.clientWidth - text.offsetWidth) / 2) - text.offsetLeft
      setSiteShift((current) => current.ready && current.x === x ? current : { x, snap: true, ready: true })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [site?.before, site?.site, site?.after])
  const travel = (next: boolean) => {
    setFocused(next)
    setSiteShift((current) => current.snap ? { ...current, snap: false } : current)
  }

  // A new tab's field takes focus for typing; its suggestions wait for the first keystroke.
  const quietFocus = useRef(false)
  useEffect(() => {
    if (!consumeFocus()) return
    quietFocus.current = true
    addressRef.current?.focus()
    quietFocus.current = false
  }, [])

  useEffect(() => {
    if (document.activeElement !== addressRef.current) setAddress(shownAddress(url))
  }, [url])

  useEffect(() => {
    if (!historyOpen || locked || lookUp === undefined) return
    const request = ++historyRequest.current
    const search = () => {
      setHistoryLoading(true)
      void lookUp(historyQuery).then(
        (found) => {
          if (historyRequest.current !== request) return
          setMatches(found)
          setHistoryLoading(false)
        },
        (reason: unknown) => {
          if (historyRequest.current !== request) return
          setHistoryLoading(false)
          onError(reason)
        },
      )
    }
    const timer = historyQuery === '' ? undefined : setTimeout(search, HISTORY_SEARCH_DEBOUNCE_MS)
    if (historyQuery === '') search()
    return () => {
      clearTimeout(timer)
      historyRequest.current += 1
    }
  }, [bridge, historyOpen, historyQuery, locked, onError])

  // The completion is a grey hint after the typed text, never part of the value, and
  // only while its site is the highlighted first row: what the hint shows is what Enter
  // opens. Tab or → at the end takes it into the field; Backspace or Delete drops it.
  const highlighted = historyOpen ? suggestions[highlight] : undefined
  const hint = historyOpen && plan.completion !== undefined && highlight === 0 ? plan.completion.rest : ''

  const closeHistory = useCallback(() => {
    historyRequest.current += 1
    setHistoryOpen(false)
  }, [])
  // Placed once from the field, so a resize or scroll closes the list rather than
  // leave it where the field used to be. Typing opens it again, placed afresh.
  useDismiss(listOpen, closeHistory, { within: [form, list], layoutMoved: true })

  const go = (target: string) => {
    if (locked || target === '') return
    closeHistory()
    addressRef.current?.blur()
    onNavigate(target)
  }

  const choose = (suggestion: AddressSuggestion) => {
    if (suggestion.kind === 'tab') {
      if (locked) return
      closeHistory()
      setAddress(shownAddress(url))
      addressRef.current?.blur()
      onSelectTab(suggestion.tab.id)
      return
    }
    const target = suggestion.kind === 'site' ? suggestion.url
      : suggestion.kind === 'visit' ? suggestion.entry.url
      : suggestion.kind === 'search' ? searchUrl(suggestion.text, searchEngine)
      : resolveBrowserAddress(suggestion.text, searchEngine)
    setAddress(suggestion.kind === 'search' || suggestion.kind === 'address' ? suggestion.text : target)
    go(target)
  }

  const open = (event: FormEvent) => {
    event.preventDefault()
    const chosen = historyOpen ? suggestions[highlight] : undefined
    if (chosen !== undefined) choose(chosen)
    else if (address.trim() !== '') go(resolveBrowserAddress(address, searchEngine))
  }

  const closeHistoryOnBlur = (event: FocusEvent<HTMLFormElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeHistory()
  }

  const addressKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keys during IME composition edit the composition, never the list or the completion.
    if (event.nativeEvent?.isComposing) return
    if (event.key === 'Escape') {
      // Escape closes the list and puts the page's own address back, selected.
      event.preventDefault()
      closeHistory()
      setAddress(shownAddress(url))
      const input = event.currentTarget
      requestAnimationFrame(() => input.select())
      return
    }
    if (!historyOpen) return
    const input = event.currentTarget
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length
    if (hint !== '' && ((event.key === 'Tab' && !event.shiftKey) || (event.key === 'ArrowRight' && atEnd))) {
      event.preventDefault()
      setAddress(address + hint)
      setHistoryQuery(address + hint)
      return
    }
    if (hint !== '' && atEnd && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault()
      setCompleting(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlight((current) => Math.min(suggestions.length - 1, Math.max(0, current + step)))
    }
  }

  return (
    <form ref={form} className="relative ml-1 flex min-w-0 flex-1 items-center rounded-full bg-surface-2 pr-1 pl-3"
      onSubmit={open} onBlur={closeHistoryOnBlur}>
      {site === null ? null : (
        <span ref={siteBox} aria-hidden
          style={trailing === undefined ? undefined : { right: 4 + 24 * trailingButtons }}
          className={`pointer-events-none absolute inset-y-0 left-3 flex items-center overflow-hidden whitespace-pre text-label text-text ${
            trailing === undefined ? 'right-3' : ''} ${locked ? 'opacity-60' : ''}`}>
          <motion.span className="flex flex-none" initial={false}
            animate={{ x: resting ? siteShift.x : 0, opacity: resting && siteShift.ready ? 1 : 0 }}
            transition={{
              x: siteShift.snap ? INSTANT : ADDRESS_TRAVEL,
              opacity: resting ? INSTANT : { ...ADDRESS_HANDOVER, delay: ADDRESS_TRAVEL.duration - ADDRESS_HANDOVER.duration },
            }}>
            <motion.span initial={false} animate={{ opacity: resting ? 0 : 1 }} transition={ADDRESS_TRAVEL}>{site.before}</motion.span>
            <span ref={siteText}>{site.site}</span>
            <motion.span initial={false} animate={{ opacity: resting ? 0 : 1 }} transition={ADDRESS_TRAVEL}>{site.after}</motion.span>
          </motion.span>
        </span>
      )}
      <span className="relative flex min-w-0 flex-1">
      {hint === '' ? null : (
        <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre text-label">
          <span className="invisible">{address}</span>
          <span className="text-dim">{hint}</span>
        </span>
      )}
      <input
        ref={addressRef}
        aria-label="Address"
        role={lookUp === undefined ? undefined : 'combobox'}
        aria-autocomplete={lookUp === undefined ? undefined : 'both'}
        aria-controls={lookUp === undefined ? undefined : listId}
        aria-expanded={lookUp === undefined ? undefined : historyOpen && !locked}
        aria-activedescendant={highlighted === undefined ? undefined : `${listId}-${highlighted.key}`}
        className={`relative min-w-0 flex-1 border-0 bg-transparent py-1.5 text-label text-text outline-none transition-opacity ease-fade ${
          focused ? 'text-left' : 'text-center'
        } ${resting ? 'opacity-0 duration-100' : `disabled:opacity-60 ${site === null ? '' : 'duration-100 delay-[260ms]'}`}`}
        placeholder="Search or enter address"
        value={address}
        disabled={locked}
        onFocus={(event) => {
          travel(true)
          event.currentTarget.select()
          // Selecting a long address would scroll it to its end; the slide lands on its start.
          event.currentTarget.scrollLeft = 0
          if (lookUp === undefined || quietFocus.current) return
          setHistoryQuery('')
          setHighlight(-1)
          setHistoryOpen(true)
        }}
        onChange={(event) => {
          const inputType = (event.nativeEvent as InputEvent | undefined)?.inputType
          // Neither a deletion nor text still being composed completes.
          setCompleting(!(typeof inputType === 'string' && (inputType.startsWith('delete') || inputType === 'insertCompositionText')))
          historyRequest.current += 1
          setAddress(event.target.value)
          setHistoryQuery(event.target.value)
          setHighlight(event.target.value.trim() === '' ? -1 : 0)
          if (lookUp !== undefined) setHistoryOpen(true)
        }}
        onKeyDown={addressKeyDown}
        onBlur={() => travel(false)}
      />
      </span>
      {trailing}
      {!listOpen || typeof document === 'undefined' ? null : createPortal(
        <BrowserHistoryResults
          id={listId}
          listRef={list}
          placement={listPlacement}
          suggestions={suggestions}
          typed={historyQuery}
          searchLabel={SEARCH_ENGINES[searchEngine].label}
          highlight={highlight}
          onHighlight={setHighlight}
          emptyMessage={suggestions.length > 0 ? '' : historyLoading ? 'Loading history…' : 'No browser history yet'}
          onChoose={choose}
        />,
        document.body,
      )}
    </form>
  )
}

/**
 * The address field owns this small list. A site or visit wears the site's mark (the
 * history glyph until one is known), the search row a glass, a typed address a globe;
 * the arrow keys move the highlight and Enter takes it.
 */
const BrowserHistoryResults = memo(function BrowserHistoryResults({
  id,
  listRef: list,
  placement,
  suggestions,
  typed,
  searchLabel,
  highlight,
  onHighlight,
  emptyMessage,
  onChoose,
}: {
  id: string
  listRef: RefObject<HTMLDivElement>
  placement: PopupPlacement | null
  suggestions: AddressSuggestion[]
  /** What was typed, bolded where a row's address contains it. */
  typed: string
  /** The search engine's name, on the search row. */
  searchLabel: string
  highlight: number
  onHighlight: (index: number) => void
  emptyMessage: string
  onChoose: (suggestion: AddressSuggestion) => void
}) {
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [highlight])
  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label="Suggestions"
      className="fixed z-40 overflow-y-auto rounded-xl border border-line surface-floating p-1 shadow-popover"
      style={placement ?? { visibility: 'hidden' }}
    >
      {suggestions.length === 0 ? (
        <p className="m-0 px-3 py-2 text-meta text-dim">
          {emptyMessage}
        </p>
      ) : suggestions.map((suggestion, index) => (
        <button
          key={suggestion.key}
          id={`${id}-${suggestion.key}`}
          type="button"
          role="option"
          aria-selected={index === highlight}
          tabIndex={-1}
          className={`flex w-full cursor-pointer items-center gap-2.5 rounded-button border-0 px-2.5 py-1.5 text-left text-label text-text [font:inherit] focus-visible:outline-none ${
            index === highlight ? 'bg-user-bg' : 'bg-transparent'
          }`}
          onMouseMove={() => { if (index !== highlight) onHighlight(index) }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(suggestion)}
        >
          <AddressRow suggestion={suggestion} typed={typed} searchLabel={searchLabel} />
        </button>
      ))}
    </div>
  )
})

function AddressRow({ suggestion, typed, searchLabel }: { suggestion: AddressSuggestion; typed: string; searchLabel: string }) {
  switch (suggestion.kind) {
    case 'search':
      return (
        <>
          <Icon icon={Search01Icon} size={14} className="flex-none text-dim" />
          <span className="block min-w-0 flex-1 truncate">
            <span className="text-dim">Search {searchLabel} for </span>{suggestion.text}
          </span>
        </>
      )
    case 'address':
      return (
        <>
          <Icon icon={GlobeIcon} size={14} className="flex-none text-dim" />
          <span className="block min-w-0 flex-1 truncate">{suggestion.text}</span>
        </>
      )
    case 'site':
      return <PageRow favicon={suggestion.favicon} title={suggestion.title} url={suggestion.url} typed={typed} />
    case 'visit':
      return <PageRow favicon={suggestion.entry.favicon} title={suggestion.entry.title} url={suggestion.entry.url} typed={typed} />
    case 'tab':
      return (
        <>
          <PageRow favicon={suggestion.tab.favicon} title={suggestion.tab.title} url={suggestion.tab.url} typed={typed} />
          <span className="flex-none text-meta text-dim">Switch to tab</span>
        </>
      )
  }
}

/** A page as one line: its mark, its title, and its address with the typed part bold. */
function PageRow({ favicon, title, url, typed }: { favicon?: string; title: string; url: string; typed: string }) {
  const address = shownUrl(url)
  const label = cleanTitle(title)
  const span = matchSpan(address, typed)
  return (
    <>
      {favicon === undefined
        ? <Icon icon={HistoryIcon} size={14} className="flex-none text-dim" />
        : <img src={favicon} alt="" className="h-3.5 w-3.5 flex-none rounded-[2px] object-contain" />}
      <span className="flex min-w-0 flex-1 items-baseline">
        {label === '' || label === address ? null : (
          <span className="min-w-0 max-w-[60%] flex-none truncate">{label}<span className="text-dim">&nbsp;–&nbsp;</span></span>
        )}
        <span className="min-w-0 flex-1 truncate text-dim">
          {span === null ? address : <>
            {address.slice(0, span[0])}
            <span className="font-medium text-text">{address.slice(span[0], span[1])}</span>
            {address.slice(span[1])}
          </>}
        </span>
      </span>
    </>
  )
}

/**
 * A tab wears the site's own mark, and a globe until one arrives. The mark is fetched
 * in the main process over the browser's own session and handed here already inlined,
 * so Manor's window never itself requests anything from a page that was visited.
 */
export function Tab({
  tab,
  active,
  disabled,
  onSelect,
  onClose,
  onPin,
  onMoveLeft,
  onMoveRight,
  reorder,
}: {
  tab: BrowserTabState
  active: boolean
  disabled: boolean
  onSelect: () => void
  onClose: () => void
  onPin?: () => void
  /** Menu steps for the keyboard; each is absent at its end of the tab's group. */
  onMoveLeft?: () => void
  onMoveRight?: () => void
  /** Present inside a `Reorder.Group`: the tab can be dragged to a new place. */
  reorder?: { dragging: boolean; bounds: RefObject<HTMLDivElement | null>; onDrop: () => void }
}) {
  const trigger = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Motion keeps an item with ref drag bounds at the same fraction of those bounds
  // whenever the window, the tab or its group resizes. For a tab at rest that is a
  // stray offset, and resizing the panel stacked tabs on top of each other. The
  // bounds are therefore handed over only while the tab is pressed. The release is
  // heard on the window: a press let go just past the tab's edge, short of a drag,
  // never reaches the tab itself.
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!held) return
    const release = () => setHeld(false)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [held])
  const placement = usePopupPlacement({ open: menuOpen, triggerRef: trigger, maxHeight: 240, minHeight: 80, minWidth: 156 })
  useDismiss(menuOpen, () => setMenuOpen(false), {
    within: [trigger, popup], layoutMoved: true, contextMenu: true,
    onEscape: () => { setMenuOpen(false); trigger.current?.querySelector('button')?.focus() },
  })
  // A blank page titles itself with its own address; a new tab says what it is.
  const label = shownAddress(tab.url) === '' ? '' : tab.title === '' ? hostOf(tab.url) : tab.title
  const name = label === '' ? 'New tab' : label
  // A tab opened past the strip's edge is scrolled to, so the one you are on is always in view.
  useEffect(() => {
    if (active) trigger.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [active])
  const shell = {
    onContextMenu: (event: ReactMouseEvent) => { event.preventDefault(); if (!disabled && onPin) setMenuOpen(true) },
    // The title runs to the tab's edge and only gives way, by the close mark's own
    // width, while the mark is showing on hover or keyboard focus.
    className: `group relative flex h-8 items-center rounded-button ${tab.pinned ? 'w-9 flex-none justify-center' : 'min-w-[90px] max-w-[200px] flex-[1_1_200px] gap-1.5 px-2 hover:pr-6 has-[:focus-visible]:pr-6'} ${
      active ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2/60'
    }`,
  }
  const menuItem = 'w-full cursor-pointer rounded-button-sm border-0 bg-transparent px-3 py-2 text-left text-label text-text hover:bg-user-bg disabled:cursor-default'
  const body = (
    <>
      {tab.pinned ? (
        <button type="button" className="grid h-full w-full cursor-pointer place-items-center border-0 bg-transparent p-0 disabled:cursor-default"
          aria-label={`${name}, pinned tab`} title={shownAddress(tab.url) === '' ? name : `${name}\n${tab.url}`}
          disabled={disabled} onClick={onSelect}
          onKeyDown={(event) => { if (event.shiftKey && event.key === 'F10' && onPin) { event.preventDefault(); setMenuOpen(true) } }}>
          {tab.favicon === undefined ? <Icon icon={Globe02Icon} size={16} className="opacity-70" />
            : <img src={tab.favicon} alt="" className="h-4 w-4 rounded-[2px] object-contain" />}
        </button>
      ) : (
        <>
          {tab.favicon === undefined ? <Icon icon={Globe02Icon} size={13} className="flex-none opacity-70" />
            : <img src={tab.favicon} alt="" className="h-[13px] w-[13px] flex-none rounded-[2px] object-contain" />}
          <button type="button"
            className="min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-meta disabled:cursor-default"
            title={shownAddress(tab.url) === '' ? name : `${name}\n${tab.url}`}
            disabled={disabled} onClick={onSelect}
            onKeyDown={(event) => { if (event.shiftKey && event.key === 'F10' && onPin) { event.preventDefault(); setMenuOpen(true) } }}>
            {name}
          </button>
        </>
      )}
      {/* A page's popup opens behind the tab being looked at, so it announces itself
          with the same dot the sidebar uses for unread, until it is selected. */}
      <AnimatePresence>
        {tab.unseen === true && !active ? (
          <motion.span
            key="unseen"
            role="img"
            aria-label="New from the page"
            className={`${tab.pinned ? 'absolute right-0.5 bottom-0.5' : 'flex-none'} h-1.5 w-1.5 rounded-full bg-primary`}
            initial={ICON_SWAP_GONE}
            animate={ICON_SWAP_REST}
            exit={ICON_SWAP_GONE}
            transition={ICON_SWAP}
          />
        ) : null}
      </AnimatePresence>
      {tab.pinned ? null : <IconButton
        icon={Cancel01Icon}
        iconSize={12}
        size={20}
        label={`Close ${name}`}
        className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
        disabled={disabled}
        onClick={onClose}
      />}
      {onPin === undefined || typeof document === 'undefined' ? null : createPortal(
        <Popover open={menuOpen} ref={popup} onReady={() => popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()}
          style={placement ?? { visibility: 'hidden' }}
          className="fixed z-40 rounded-panel border border-line surface-floating p-1 shadow-menu"
          role="menu" aria-label={`${name} tab actions`}>
          <button type="button" role="menuitem" disabled={disabled} className={menuItem}
            onClick={() => { setMenuOpen(false); onPin() }}>{tab.pinned ? 'Unpin tab' : 'Pin tab'}</button>
          {onMoveLeft === undefined ? null : (
            <button type="button" role="menuitem" disabled={disabled} className={menuItem}
              onClick={() => { setMenuOpen(false); onMoveLeft() }}>Move tab left</button>
          )}
          {onMoveRight === undefined ? null : (
            <button type="button" role="menuitem" disabled={disabled} className={menuItem}
              onClick={() => { setMenuOpen(false); onMoveRight() }}>Move tab right</button>
          )}
          <button type="button" role="menuitem" disabled={disabled} className={menuItem}
            onClick={() => { setMenuOpen(false); onClose() }}>Close tab</button>
        </Popover>, document.body,
      )}
    </>
  )
  if (reorder === undefined) return <span ref={trigger} {...shell}>{body}</span>
  return (
    <Reorder.Item as="span" ref={trigger} value={tab.id} {...shell}
      drag={disabled ? false : 'x'}
      // A tab stops at its group's ends, as in a browser, instead of sliding under
      // the strip's clipped edge or into the pins.
      dragConstraints={held ? reorder.bounds : undefined}
      dragElastic={0}
      // Neighbours slide aside only during a drag; any other layout change (a tab
      // closing, the panel resizing) lands at once, as it did before tabs could move.
      layout="position"
      transition={{ layout: reorder.dragging ? TAB_REORDER : INSTANT }}
      // Ctrl+click is the context click on macOS. Its menu swallows the release, so a
      // press with Ctrl must not arm a drag that would never end.
      onPointerDownCapture={(event: ReactPointerEvent) => { if (event.ctrlKey) event.stopPropagation() }}
      onPointerDown={() => { if (!disabled) setHeld(true) }}
      onDragEnd={reorder.onDrop}>
      {body}
    </Reorder.Item>
  )
}

/**
 * Stands in for the address row while a tab's sign-in popup covers its page. The
 * popup's own domain is the address, so a password field always says where it goes;
 * page actions are gone because they would act on the page hidden underneath.
 */
function BrowserSignInBar({ url, passwords, adblock, onCancel }: {
  url: string; passwords: ReactNode; adblock: ReactNode; onCancel: (() => void) | undefined
}) {
  const host = hostOf(url)
  return (
    <div role="group" aria-label="Sign-in window" className="flex h-12 min-w-0 items-center gap-2 pr-2 pl-4">
      <span className="flex-none text-label font-medium text-text">Sign in</span>
      <span aria-live="polite" title={url} className="min-w-0 flex-1 truncate text-label text-muted">
        {host === '' ? url : host}
      </span>
      {passwords}
      {adblock}
      <Button size="compact" disabled={onCancel === undefined} onClick={onCancel}>Cancel</Button>
    </div>
  )
}

/** The switch is per host, so its label names the host and, while blocking, this page's count. */
export function adblockLabel(adblock: BrowserTabAdblock, pageUrl: string): string {
  const host = new URL(pageUrl).hostname
  if (!adblock.blocking) return `Ad blocking is off on ${host}. Turn it on`
  const blocked = adblock.blocked === 0 ? 'Nothing blocked yet' : `${adblock.blocked} ${adblock.blocked === 1 ? 'ad or tracker' : 'ads and trackers'} blocked`
  return `${blocked}. Turn off ad blocking on ${host}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
