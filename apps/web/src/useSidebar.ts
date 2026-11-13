import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { Chat } from '@manor/contracts'

const COLLAPSED_KEY = 'manor:sidebar-collapsed'
const WIDTH_KEY = 'manor:sidebar-width'
const VIEW_KEY = 'manor:sidebar-view'

/**
 * What the panel's scroll region lists: everyone in the house as one messaging
 * list, or every chat in it as an inbox to work through. Chrome state for one
 * browser, like the collapse and the width, so it is remembered next to them and
 * never reaches the server.
 */
export type SidebarView = 'chats' | 'inbox'

export type SidebarMotion = 'peek' | 'pin' | 'instant'

/**
 * The stored view, read forgivingly. `projects` is what this key held before the
 * chat list replaced the rooms in that slot, and it reads as `chats`: the panel
 * that browser last had open is gone, and the list that took its place is the
 * closest honest answer. Anything unrecognised falls to the same default.
 */
export function sidebarViewFrom(stored: string | null): SidebarView {
  return stored === 'inbox' ? 'inbox' : 'chats'
}

/**
 * Project work lives in the inbox. DMs and groups live in the household chat list. A
 * run belongs to neither list — it is reached from its routine — but opening one
 * still has to pick a sidebar, and the inbox is where the routine section sits.
 */
export function sidebarViewForChat(kind: Chat['kind']): SidebarView {
  return kind === 'project' || kind === 'run' ? 'inbox' : 'chats'
}

/**
 * What Sessions remembers when it was left on its New session stage rather than on a
 * thread. Never a chat id, so it cannot match a row.
 */
export const LEFT_ON_NEW_SESSION = 'new-session'

/**
 * Which thread a list lands on when it comes back into view, the one it was left on,
 * else its first row. `remembered` is checked against the roster rather than trusted,
 * because the chat it names can since have been deleted or moved to the other list.
 * Undefined means the landing is the list's natural draft instead: the list holds no
 * thread at all, or Sessions was left on New session.
 */
export function landingChat<T extends Pick<Chat, 'id' | 'kind'>>(
  chats: readonly T[],
  view: SidebarView,
  remembered: string | null,
): T | undefined {
  if (view === 'inbox' && remembered === LEFT_ON_NEW_SESSION) return undefined
  // Runs live under their routine and Browser sessions under Browser; neither is a list's landing.
  const inView = (chat: T) => chat.kind !== 'run' && chat.kind !== 'browser' && sidebarViewForChat(chat.kind) === view
  return chats.find((chat) => chat.id === remembered && inView(chat)) ?? chats.find(inView)
}

export const SIDEBAR_MIN_WIDTH = 232
export const SIDEBAR_DEFAULT_WIDTH = 288
export const SIDEBAR_MAX_WIDTH = 420

/** The rail and the frame's gutter (NavRail, TopBar), the doors' room and the smallest useful chat beside a pinned sidebar. */
export const SIDEBAR_REMAINING_FLOOR = 46 + 4 + 44 + 375

/**
 * A narrow window turns the pinned sidebar into a temporary drawer. The stored
 * preference is left alone, so widening the window restores the desktop layout.
 */
export function sidebarOverlays(
  viewportWidth: number,
  sidebarWidth: number,
  remainingFloor = SIDEBAR_REMAINING_FLOOR,
) {
  return viewportWidth < sidebarWidth + remainingFloor
}

const RESIZE_STEP = 16

/** How close to the left edge starts a peek. Narrow enough to never fire by accident. */
const HOT_EDGE_PX = 8

/**
 * How far right the pointer may wander before a peek ends. The widest the panel
 * ever gets, so leaving the panel always closes it, whatever width it is at.
 */
const PEEK_HANDLE_PX = 8

/**
 * How long a reported leave may go unconfirmed before it ends the peek. The
 * macOS shell draws a native strip over the top of the page (traffic lights,
 * drag region) that reports a leave for a pointer still inside the window, and
 * the next move retracts it. A pointer silent for this long really is gone.
 */
const PEEK_LEAVE_GRACE_MS = 250

export function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width))
}

/**
 * Whether the panel should be floating in, for a pointer that has landed at `x`. A
 * peek starts only at the very edge and then survives anywhere over the panel, so
 * arriving is deliberate and leaving is not. `held` is an overlay anchored to the
 * panel saying it is still in use, wherever the pointer has since gone: the project
 * card hangs beside the sidebar, and reaching for it crosses ground that otherwise
 * reads as leaving.
 */
export function peekAfterMove({
  x,
  width,
  peeking,
  held,
}: {
  x: number
  width: number
  peeking: boolean
  held: boolean
}) {
  if (!peeking) return x <= HOT_EDGE_PX
  return held || x < width + PEEK_HANDLE_PX
}

/**
 * The sidebar's whole state: folded away or not (remembered across reloads), and
 * whether it is floating in on a hover of the left edge (never remembered, it
 * belongs to where the mouse is right now). Collapse and width are chrome state
 * for one browser, so both live in localStorage and never reach the server.
 *
 * `shortcutsActive` is off while focus mode hides the sidebar, so ⌘S cannot change it unseen.
 */
export function useSidebar(phoneLanding = false, shortcutsActive = true) {
  const [pinnedCollapsed, setPinnedCollapsed] = useState(readCollapsed)
  const [width, setWidth] = useState(readWidth)
  const [view, setView] = useState(readView)
  const [peeking, setPeeking] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)
  /**
   * Whether the destination on stage brings a list at all. Where it does not, the
   * panel is away whatever was pinned, and the pin is kept for the next list.
   */
  const [available, setAvailableState] = useState(true)
  const availableRef = useRef(true)
  const setAvailable = useCallback((next: boolean) => {
    if (availableRef.current === next) return
    availableRef.current = next
    setMotion('instant')
    setAvailableState(next)
  }, [])
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [resizing, setResizing] = useState(false)
  const resizingRef = useRef(false)
  const resizeStart = useRef({ x: 0, width: SIDEBAR_DEFAULT_WIDTH })
  /**
   * How many overlays anchored to the panel are on screen. The project card hangs
   * beside the sidebar rather than inside it, so a pointer moving into it is a
   * pointer that left, and the peek it is anchored to would fold out from under it.
   * Counted rather than flagged, because one card can still be fading while the
   * next one opens.
   */
  const holds = useRef(0)
  const [held, setHeld] = useState(false)
  /** Where the pointer was last seen, so a released hold can settle the peek at once. */
  const pointerX = useRef(Number.POSITIVE_INFINITY)
  /** A reported leave still waiting out its grace, so a retracting move can cancel it. */
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimer.current === null) return
    clearTimeout(leaveTimer.current)
    leaveTimer.current = null
  }, [])
  /**
   * What moved the panel last. A peek is a hover, so it has to answer at hover
   * speed; pinning and unpinning move the chat with them and read better at the
   * calmer tempo. Both end in the same two states, so only the cause can tell
   * them apart. `instant` is a rail door arriving at a destination with or without a
   * list: a change of place, not a panel moving, so the stage lands in one frame.
   */
  const [motion, setMotion] = useState<SidebarMotion>('pin')

  const overlay = sidebarOverlays(viewportWidth, width)
  const collapsed = !available || (overlay ? !overlayOpen : pinnedCollapsed)

  // A phone opens for triage. The effect only runs when entering this width mode,
  // so opening a thread can close the list without it immediately reopening.
  useEffect(() => {
    if (!phoneLanding) return
    setView('inbox')
    setOverlayOpen(true)
  }, [phoneLanding])

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // A drawer never stays standing open after the window returns to desktop size.
  useEffect(() => {
    if (!overlay) setOverlayOpen(false)
  }, [overlay])

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, pinnedCollapsed ? '1' : '0')
    } catch {
      // Private-mode or blocked storage: the sidebar still folds, it just forgets.
    }
  }, [pinnedCollapsed])

  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      // The current width still works when storage is unavailable.
    }
  }, [width])

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view)
    } catch {
      // The panel still switches views when storage is unavailable, it just forgets.
    }
  }, [view])

  // Read by `holdPeek`, which has to stay stable: the overlays that claim a hold
  // release it from an effect cleanup, and a callback that changed on every resize
  // would make them let go and grab again mid-hover.
  const widthRef = useRef(width)
  useEffect(() => {
    widthRef.current = width
  }, [width])

  // A peek that ended by any other road makes a pending leave moot, and an
  // unmounted sidebar waits for nothing.
  useEffect(() => clearLeaveTimer, [peeking, clearLeaveTimer])

  useEffect(() => {
    if (!resizing) return
    const cursor = document.body.style.cursor
    const userSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
    }
  }, [resizing])

  // Pinning the panel open ends the peek, otherwise a later fold would find
  // `peeking` still true and leave the sidebar on screen with no mouse near it.
  const toggle = useCallback(() => {
    // ⌘S over a destination with no list would flip a pin nobody can see.
    if (!available) return
    setMotion('pin')
    if (overlay) setOverlayOpen((current) => !current)
    else setPinnedCollapsed((current) => !current)
    setPeeking(false)
  }, [overlay, available])

  const closeOverlay = useCallback(() => {
    if (overlay) setOverlayOpen(false)
  }, [overlay])

  const toggleView = useCallback(() => {
    setView((current) => (current === 'inbox' ? 'chats' : 'inbox'))
  }, [])

  const showView = useCallback((next: SidebarView) => {
    setView(next)
  }, [])

  const finishResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    resizingRef.current = false
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      resizeStart.current = { x: event.clientX, width }
      resizingRef.current = true
      setResizing(true)
    },
    [width],
  )

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current) return
    setWidth(clampSidebarWidth(resizeStart.current.width + event.clientX - resizeStart.current.x))
  }, [])

  const resetWidth = useCallback(() => {
    setWidth(SIDEBAR_DEFAULT_WIDTH)
  }, [])

  const onResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const directions: Partial<Record<string, number>> = {
      ArrowLeft: -RESIZE_STEP,
      ArrowRight: RESIZE_STEP,
    }
    const delta = directions[event.key]
    if (delta !== undefined) {
      event.preventDefault()
      setWidth((current) => clampSidebarWidth(current + delta))
      return
    }
    if (event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    setWidth(event.key === 'Home' ? SIDEBAR_MIN_WIDTH : SIDEBAR_MAX_WIDTH)
  }, [])

  // Cmd/Ctrl+S folds the left sidebar. Cmd/Ctrl+B used to live here too (the
  // shortcut Linear and VS Code trained into the hand) but now toggles the right
  // rail instead, see useRightPanel. The file/knowledge panels claim Cmd+S for
  // themselves in capture phase when they have something open, so this never
  // fires over an actual save.
  useEffect(() => {
    if (!shortcutsActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      // Lowercased because Caps Lock reports 'S' while shiftKey stays false.
      if (event.key.toLowerCase() !== 's' || event.repeat) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle, shortcutsActive])

  /**
   * Pointer position decides the peek, rather than enter/leave on a hot-zone
   * element: the panel slides over that zone as it arrives, so the two would
   * race and could leave the sidebar stuck open over the chat.
   */
  const onMouseMove = useCallback(
    (event: MouseEvent) => {
      // A move proves the pointer is inside and retracts a reported leave.
      clearLeaveTimer()
      if (overlay || !collapsed || resizingRef.current) return
      const x = event.clientX
      pointerX.current = x
      const next = peekAfterMove({ x, width, peeking, held })
      // Nothing is set on a pointer that only moved: no render, and no retiming
      // of a slide that is still running.
      if (next === peeking) return
      setMotion('peek')
      setPeeking(next)
    },
    [clearLeaveTimer, collapsed, held, overlay, peeking, width],
  )

  /**
   * A leave ends the peek only once it has outlived its grace. Crossing the
   * native strip at the top of the window reports a leave for a pointer that is
   * still inside, so the bare event cannot be trusted on its own. The checks at
   * fire time are refs because a hold or a resize can begin during the grace.
   */
  const onMouseLeave = useCallback(() => {
    if (!peeking || resizingRef.current || held) return
    clearLeaveTimer()
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null
      if (resizingRef.current || holds.current > 0) return
      setMotion('peek')
      setPeeking(false)
    }, PEEK_LEAVE_GRACE_MS)
  }, [clearLeaveTimer, held, peeking])

  /**
   * Claimed while an overlay anchored to the panel is on screen, released when it
   * goes. The release settles the peek against where the pointer actually is, so a
   * card dismissed under a stationary mouse does not leave the panel out.
   */
  const holdPeek = useCallback((claim: boolean) => {
    holds.current = Math.max(0, holds.current + (claim ? 1 : -1))
    setHeld(holds.current > 0)
    if (holds.current > 0 || resizingRef.current) return
    const stay = peekAfterMove({ x: pointerX.current, width: widthRef.current, peeking: true, held: false })
    if (stay) return
    setMotion('peek')
    setPeeking(false)
  }, [])

  /**
   * Memoised because it is handed to a memoised `Sidebar` as one prop, so a fresh
   * object here would be a changed prop on every streaming delta and the memo would
   * do nothing. It only really changes when the width does.
   *
   * `peekProps` below is deliberately not memoised: it is spread onto a plain `div`,
   * where React diffs the individual handlers and the bag's identity means nothing.
   */
  const resizeProps = useMemo(
    () => ({
      role: 'separator' as const,
      'aria-label': 'Resize sidebar',
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': SIDEBAR_MIN_WIDTH,
      'aria-valuemax': SIDEBAR_MAX_WIDTH,
      'aria-valuenow': width,
      tabIndex: 0,
      title: 'Drag to resize. Double-click to reset.',
      onPointerDown: onResizePointerDown,
      onPointerMove: onResizePointerMove,
      onPointerUp: finishResize,
      onPointerCancel: finishResize,
      onLostPointerCapture: finishResize,
      onDoubleClick: resetWidth,
      onKeyDown: onResizeKeyDown,
    }),
    [width, onResizePointerDown, onResizePointerMove, finishResize, resetWidth, onResizeKeyDown],
  )

  return {
    collapsed,
    overlay,
    width,
    view,
    peeking,
    resizing,
    motion,
    toggle,
    setAvailable,
    closeOverlay,
    toggleView,
    showView,
    holdPeek,
    peekProps: { onMouseMove, onMouseLeave },
    resizeProps,
  }
}

function readCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function readView(): SidebarView {
  try {
    return sidebarViewFrom(window.localStorage.getItem(VIEW_KEY))
  } catch {
    return 'chats'
  }
}

function readWidth() {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}
