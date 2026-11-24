import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react'
import { AGENT_SETTINGS_WIDTH, AGENTS_PANEL_WIDTH, CHAT_STAGE_MIN_WIDTH, DOCK_PANEL_GAP, LIST_PANEL_WIDTH, type RightPanelId } from './useRightPanel'

export const FILES_TREE_WIDTH = 240
export const FILES_PREVIEW_MIN_WIDTH = 320
export const FILES_MIN_WIDTH = 360
// The default still opens both columns. Below it the selected file decides which
// single column survives, so resizing can continue down to the usable panel floor.
export const FILES_DEFAULT_WIDTH = FILES_TREE_WIDTH + FILES_PREVIEW_MIN_WIDTH + DOCK_PANEL_GAP + 2
export const FILES_MAX_WIDTH = 2_400

/**
 * The browser's floor is a phone-width page, a real thing to want beside a chat, and
 * its ceiling is the window rather than a number, because "as wide as this screen
 * allows" is what reading a site next to a conversation actually means. The shared
 * right-panel width below borrows this floor, the tightest any panel tolerates.
 */
// 375 is the page, not the track: the card gives the gutter it floats in back and
// another 16 to the well the native view sits in, so the phone-width floor the
// paragraph above promises is only true if the track carries all three.
export const BROWSER_MIN_WIDTH = CHAT_STAGE_MIN_WIDTH + DOCK_PANEL_GAP + 16
// A page opens at a narrow tablet layout rather than its phone one, and still docks
// beside a 375px chat on a 1440 laptop with the sidebar open.
export const BROWSER_DEFAULT_WIDTH = 720

/**
 * What a resizable right-hand panel needs to know about itself. The right rail and
 * the Browser session pane use it, which is why it is a parameter rather than more
 * constants: the drag, the clamp and the remembered width are one behaviour, and a
 * second copy of it is how they would start disagreeing about what "too narrow" means.
 */
interface PanelSizeOptions {
  widthKey: string
  minWidth: number
  defaultWidth: number
  maxWidth: number
  label: string
}

/**
 * A side chat is a conversation, so it opens at the width the roster already
 * found cramped and can be dragged to the same ceiling the files panel has. No
 * expand: covering the parent chat is the opposite of what this panel is for.
 */
/** Where the diff opens: a stacked diff reads well here, and dragged past 900 it offers Split. */
export const DIFF_DEFAULT_WIDTH = 720
export const SIDE_DEFAULT_WIDTH = 432
export const SIDE_MAX_WIDTH = 880

const RESIZE_STEP = 16

/**
 * Bounded by the panel's own limits and by the window, because a width remembered on
 * a wide screen would otherwise reopen on a laptop with no chat left beside it.
 */
export function clampPanelWidth(
  width: number,
  available = Number.POSITIVE_INFINITY,
  bounds: { minWidth: number; maxWidth: number } = { minWidth: FILES_MIN_WIDTH, maxWidth: FILES_MAX_WIDTH },
) {
  // Covering the transcript entirely is the expand button's job, so the drag never
  // gets there by accident.
  const ceiling = Math.max(bounds.minWidth, Math.min(bounds.maxWidth, available - CHAT_STAGE_MIN_WIDTH))
  return Math.min(ceiling, Math.max(bounds.minWidth, width))
}

/**
 * Every chat remembers each right-rail panel's width on its own, so widening the
 * browser in one session leaves the next session alone, and a chat that never sized
 * a panel opens it at that panel's default. The floor is the browser's, the tightest
 * any reading panel tolerates, and the ceiling is the window's.
 */
export function rightPanelDefaultWidth(panel: RightPanelId) {
  switch (panel) {
    case 'browser': return BROWSER_DEFAULT_WIDTH
    // Conversations and memory notes read as one column of text.
    case 'side':
    case 'memory': return SIDE_DEFAULT_WIDTH
    case 'agents': return AGENTS_PANEL_WIDTH
    case 'agent': return AGENT_SETTINGS_WIDTH
    // Code wants the room of a page: stacked lines with both gutters, split once it is wider.
    case 'diff': return DIFF_DEFAULT_WIDTH
    case 'runs':
    // Files and Knowledge open with their tree and preview side by side.
    default: return FILES_DEFAULT_WIDTH
  }
}

/**
 * `viewportWidth` is the width the panel may spend, passed in rather than read from
 * `window`, because the window is the one input that changes without anything in
 * here being told.
 */
export function useRightPanelSize(
  chatId: string,
  panel: RightPanelId,
  viewportWidth = window.innerWidth,
  overlayResizable = false,
) {
  const options = useMemo<PanelSizeOptions>(() => ({
    widthKey: `manor:right-panel-width:${chatId}:${panel}`,
    minWidth: BROWSER_MIN_WIDTH,
    defaultWidth: rightPanelDefaultWidth(panel),
    maxWidth: FILES_MAX_WIDTH,
    label: 'side',
  }), [chatId, panel])
  return usePanelSize(options, viewportWidth, overlayResizable)
}

export const BROWSER_EXPANDED_KEY = 'manor:browser-expanded'
const EXPAND_PANEL_EVENT = 'manor:expand-panel'

/**
 * Puts one chat's panel over the whole stage from outside its region, as a delivered
 * page's Open in browser does for Browser. A split view mounts a region per chat, so
 * only `chatId`'s expands.
 */
export function expandPanel(expandedKey: string, chatId: string) {
  window.dispatchEvent(new CustomEvent(EXPAND_PANEL_EVENT, { detail: { expandedKey, chatId } }))
}

/**
 * Whether one panel is covering the whole stage. Kept per panel even though the
 * width is shared: expanding Files is not a reason to open the browser over the chat.
 */
export function usePanelExpanded(expandedKey: string, chatId?: string) {
  const [expanded, setExpanded] = useState(() => readExpanded(expandedKey))
  useEffect(() => {
    // Only a panel bound to a chat can be expanded from outside its region.
    if (chatId === undefined) return
    const onExpand = (event: Event) => {
      const asked = (event as CustomEvent<{ expandedKey: string; chatId: string }>).detail
      if (asked.expandedKey === expandedKey && asked.chatId === chatId) setExpanded(true)
    }
    window.addEventListener(EXPAND_PANEL_EVENT, onExpand)
    return () => window.removeEventListener(EXPAND_PANEL_EVENT, onExpand)
  }, [expandedKey, chatId])
  useEffect(() => {
    try {
      window.localStorage.setItem(expandedKey, expanded ? '1' : '0')
    } catch {
      // The panel still expands, the choice just does not survive a reload.
    }
  }, [expandedKey, expanded])
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), [])
  return { expanded, toggleExpanded }
}

/**
 * The chat beside the Browser stage. It opens at the side chat's conversation width
 * and floors at the chat width, so neither the page nor the thread is squeezed out.
 */
const BROWSER_SESSION_OPTIONS: PanelSizeOptions = {
  widthKey: 'manor:browser-session-width',
  minWidth: CHAT_STAGE_MIN_WIDTH + DOCK_PANEL_GAP,
  defaultWidth: SIDE_DEFAULT_WIDTH,
  maxWidth: SIDE_MAX_WIDTH,
  label: 'browser session',
}

export function useBrowserSessionPane(viewportWidth = window.innerWidth) {
  return usePanelSize(BROWSER_SESSION_OPTIONS, viewportWidth)
}

/**
 * A right-hand panel's width beside the chat. It belongs to one browser rather than
 * to the workspace, so it lives in localStorage and never reaches the server. Whether
 * the panel covers the stage is `usePanelExpanded`'s, kept per panel by its caller.
 */
function usePanelSize(options: PanelSizeOptions, viewportWidth: number, overlayResizable = false) {
  // A floating split panel no longer owes the transcript its usual 375px floor.
  // Its card still keeps the shared 8px gutter inside the owning pane.
  const resizeAvailable = viewportWidth + (overlayResizable ? CHAT_STAGE_MIN_WIDTH - DOCK_PANEL_GAP : 0)
  const widthKey = options.widthKey
  // The key moves when the chat or the panel does, and the width moves with it: read
  // during the render, so the first frame of another chat is already its own width.
  const [stored, setStored] = useState(() => ({ key: widthKey, width: readWidth(widthKey, options.defaultWidth) }))
  let asked = stored.width
  if (stored.key !== widthKey) {
    asked = readWidth(widthKey, options.defaultWidth)
    setStored({ key: widthKey, width: asked })
  }
  const setAsked = useCallback((next: SetStateAction<number>) => setStored((current) => ({
    key: current.key,
    width: typeof next === 'function' ? next(current.width) : next,
  })), [])
  const [resizing, setResizing] = useState(false)
  const resizingRef = useRef(false)
  const resizeStart = useRef({ x: 0, width: options.defaultWidth })

  // Resizing the thread changes whether the panel docks, not its chosen width.
  // The shell caps an overlay to its pane without spending the stored preference.
  const width = clampPanelWidth(asked, Number.POSITIVE_INFINITY, options)

  useEffect(() => {
    try {
      // The default is what an untouched panel reads anyway, so storing it would only
      // leave a key behind for every chat the panel was ever opened in.
      if (stored.width === options.defaultWidth) window.localStorage.removeItem(stored.key)
      else window.localStorage.setItem(stored.key, String(stored.width))
    } catch {
      // The current width still works when storage is unavailable, it just forgets.
    }
  }, [stored, options.defaultWidth])

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

  // A drag is a new preference, so it is clamped on the way in: what the pointer can
  // reach on this window is the most the panel may ask for later.
  const resize = useCallback((next: number) => {
    setAsked(clampPanelWidth(next, resizeAvailable, options))
  }, [options, resizeAvailable])

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
      const visibleWidth = event.currentTarget.parentElement!.getBoundingClientRect().width + DOCK_PANEL_GAP
      resizeStart.current = { x: event.clientX, width: Math.min(width, visibleWidth) }
      resizingRef.current = true
      setResizing(true)
    },
    [width],
  )

  // The handle sits on the panel's left edge, so dragging left widens it. Every
  // direction below is mirrored from the sidebar's for that reason.
  const onResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizingRef.current) return
      // An existing overlay can shrink smoothly back to docking, but a drag cannot
      // make it cover more chat than it already did when the gesture started.
      const dragAvailable = Math.max(resizeAvailable, resizeStart.current.width + CHAT_STAGE_MIN_WIDTH)
      setAsked(clampPanelWidth(resizeStart.current.width - (event.clientX - resizeStart.current.x), dragAvailable, options))
    },
    [options, resizeAvailable],
  )

  const onResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const directions: Partial<Record<string, number>> = {
        ArrowLeft: RESIZE_STEP,
        ArrowRight: -RESIZE_STEP,
      }
      const delta = directions[event.key]
      if (delta !== undefined) {
        event.preventDefault()
        resize(width + delta)
        return
      }
      if (event.key !== 'Home' && event.key !== 'End') return
      event.preventDefault()
      resize(event.key === 'Home' ? options.maxWidth : options.minWidth)
    },
    [options, resize, width],
  )

  return {
    width,
    /**
     * The stored width before this panel's own floor. Columns sharing the region go
     * below that floor, so the first of them drives the same width through here and a
     * panel left alone again opens where its column was.
     */
    chosenWidth: Math.min(options.maxWidth, asked),
    setChosenWidth: setAsked,
    defaultWidth: options.defaultWidth,
    resizing,
    resizeProps: {
      'data-panel-resizing': resizing ? true : undefined,
      role: 'separator' as const,
      'aria-label': `Resize ${options.label} panel`,
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': options.minWidth,
      'aria-valuemax': options.maxWidth,
      'aria-valuenow': width,
      tabIndex: 0,
      title: 'Drag to resize. Double-click to reset.',
      onPointerDown: onResizePointerDown,
      onPointerMove: onResizePointerMove,
      onPointerUp: finishResize,
      onPointerCancel: finishResize,
      onLostPointerCapture: finishResize,
      onDoubleClick: () => resize(options.defaultWidth),
      onKeyDown: onResizeKeyDown,
    },
  }
}

function readWidth(key: string, defaultWidth: number) {
  try {
    const stored = Number(window.localStorage.getItem(key))
    return Number.isFinite(stored) && stored > 0 ? stored : defaultWidth
  } catch {
    return defaultWidth
  }
}

function readExpanded(expandedKey: string) {
  try {
    return window.localStorage.getItem(expandedKey) === '1'
  } catch {
    return false
  }
}
