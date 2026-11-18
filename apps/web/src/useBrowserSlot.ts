import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import type { BrowserViewportBounds, DesktopBrowserBridge, DesktopBrowserWebviewsBridge } from '@manor/contracts'

export const isPersistentBrowserProfileFailure = (reason: unknown): boolean =>
  (reason instanceof Error ? reason.message : String(reason)).includes('MANOR_BROWSER_PROFILE_UNAVAILABLE')

// Sidebar and thumbnail trade this lease; obsolete cleanup cannot hide the new slot.
const slots = new WeakMap<DesktopBrowserBridge, { owner: symbol | null; pending: Promise<void> }>()

/**
 * The sidebar frame, and the window its clipping ancestors leave open; `null` when nothing clips.
 * `corners` rounds that window, top-left clockwise: the frame's own corner, or the corner
 * of a rounded box that clips it where the two meet, so a page flush in the window's
 * inset is cut along the inset's curve rather than poking out square.
 */
export interface BrowserFrame extends BrowserViewportBounds {
  clip: BrowserViewportBounds | null
  corners: Corners
}

type Corners = [number, number, number, number]

// The sidebar frame as the renderer last measured it. The desktop host echoes the same
// bounds a few frames later; a filling guest follows this instead, so a drag moves it
// in the frame the panel moves, even while an agent action holds the host's layout.
//
// `settling` covers a sidebar slot changing hands. Until the host has shown the new
// owner's page, the guest on screen may still be the previous chat's, and following
// the new frame would paint that page into the new panel for a moment.
//
// `vacant` is a sidebar slot whose tab is blank. Its panel draws its own page there, so
// the guest stays out of sight while the host keeps the slot, and with it the shortcuts.
const frames = new WeakMap<DesktopBrowserWebviewsBridge, { bounds: BrowserFrame | null; settling: boolean; vacant: boolean; listeners: Set<() => void> }>()
const frameOf = (webviews: DesktopBrowserWebviewsBridge) => {
  let entry = frames.get(webviews)
  if (!entry) frames.set(webviews, entry = { bounds: null, settling: false, vacant: false, listeners: new Set() })
  return entry
}
const publishFlag = (webviews: DesktopBrowserWebviewsBridge, flag: 'settling' | 'vacant', value: boolean) => {
  const entry = frameOf(webviews)
  if (entry[flag] === value) return
  entry[flag] = value
  for (const listener of entry.listeners) listener()
}
const publishSettling = (webviews: DesktopBrowserWebviewsBridge, settling: boolean) => publishFlag(webviews, 'settling', settling)
const publishFrame = (webviews: DesktopBrowserWebviewsBridge, bounds: BrowserFrame | null) => {
  const entry = frameOf(webviews)
  if (entry.bounds === bounds || (entry.bounds && bounds && JSON.stringify(entry.bounds) === JSON.stringify(bounds))) return
  entry.bounds = bounds
  for (const listener of entry.listeners) listener()
}

/** The live sidebar frame for guests that fill it; `null` when no sidebar slot owns the page. */
export function useBrowserFrame(webviews: DesktopBrowserWebviewsBridge | undefined): BrowserFrame | null {
  const subscribe = useCallback((listener: () => void) => {
    if (!webviews) return () => {}
    const { listeners } = frameOf(webviews)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [webviews])
  return useSyncExternalStore(subscribe, () => webviews ? frameOf(webviews).bounds : null)
}

/**
 * True while sidebar guests stay out of sight: the slot waits for the host to show its
 * chat's page, or its tab is blank.
 */
export function useBrowserSidebarHidden(webviews: DesktopBrowserWebviewsBridge | undefined): boolean {
  const subscribe = useCallback((listener: () => void) => {
    if (!webviews) return () => {}
    const { listeners } = frameOf(webviews)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [webviews])
  return useSyncExternalStore(subscribe, () => webviews ? frameOf(webviews).settling || frameOf(webviews).vacant : false)
}

/**
 * The window a frame's clipping ancestors leave open. Guests are fixed to the body, so
 * no panel's overflow reaches them: a panel row scrolled sideways would carry the page
 * out over its neighbours. As in CSS, an absolute box escapes the overflow of the
 * static ancestors between it and its containing block, so an expanded panel is not
 * cut back to the row it came from.
 */
function clipOf(node: HTMLElement, bounds: BrowserViewportBounds): Pick<BrowserFrame, 'clip' | 'corners'> {
  let left = -Infinity, top = -Infinity, right = Infinity, bottom = Infinity
  const rounded: Array<{ left: number; top: number; right: number; bottom: number; radii: Corners }> = []
  const own = node.parentElement ? getComputedStyle(node) : null
  let position = own?.position ?? 'static'
  if (own) rounded.push({ left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height, radii: radiiOf(own, 0) })
  let escaping = false
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (position === 'fixed') break
    if (position === 'absolute') escaping = true
    const style = getComputedStyle(parent)
    position = style.position
    if (escaping && position === 'static') continue
    escaping = false
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const box = parent.getBoundingClientRect()
    const x = box.x + parent.clientLeft, y = box.y + parent.clientTop
    if (style.overflowX !== 'visible') { left = Math.max(left, x); right = Math.min(right, x + parent.clientWidth) }
    if (style.overflowY !== 'visible') { top = Math.max(top, y); bottom = Math.min(bottom, y + parent.clientHeight) }
    // Overflow clips to the padding box, whose corner is the border's less the border.
    rounded.push({ left: x, top: y, right: x + parent.clientWidth, bottom: y + parent.clientHeight, radii: radiiOf(style, Math.max(parent.clientLeft, parent.clientTop)) })
  }
  let clip: BrowserViewportBounds | null = null
  if (left !== -Infinity || top !== -Infinity || right !== Infinity || bottom !== Infinity) {
    // An axis nothing clips spans the whole screen.
    left = Math.max(left, 0); top = Math.max(top, 0)
    right = Math.min(right, window.innerWidth); bottom = Math.min(bottom, window.innerHeight)
    clip = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
  }
  return { clip, corners: cornersOf(clip === null ? bounds : intersect(bounds, clip), rounded) }
}

const radiusOf = (value: string | undefined, inset: number) => Math.max(0, (Number.parseFloat(value ?? '') || 0) - inset)
const radiiOf = (style: CSSStyleDeclaration, inset: number): Corners => [
  radiusOf(style.borderTopLeftRadius, inset), radiusOf(style.borderTopRightRadius, inset),
  radiusOf(style.borderBottomRightRadius, inset), radiusOf(style.borderBottomLeftRadius, inset),
]

/** The part of `bounds` inside `clip`, as the guest host draws it. */
export function intersect(bounds: BrowserViewportBounds, clip: BrowserViewportBounds): BrowserViewportBounds {
  const x = Math.max(bounds.x, clip.x), y = Math.max(bounds.y, clip.y)
  return {
    x, y,
    width: Math.max(0, Math.min(bounds.x + bounds.width, clip.x + clip.width) - x),
    height: Math.max(0, Math.min(bounds.y + bounds.height, clip.y + clip.height) - y),
  }
}

/**
 * Each corner of the shown window, rounded just enough to stay inside every rounded box
 * around it. For a box corner `r` and a window corner `dx` and `dy` in from its edges,
 * the smallest arc that fits is `r - (dx + dy + sqrt(2 dx dy))`: the box's own corner
 * when flush, shrinking to nothing as the window moves in. So a page sliding toward the
 * inset's corner (the chat closing) curves in step instead of poking out square, and a
 * docked panel's page, well inside its card's curve, keeps its own corner.
 */
function cornersOf(shown: BrowserViewportBounds, boxes: ReadonlyArray<{ left: number; top: number; right: number; bottom: number; radii: Corners }>): Corners {
  const right = shown.x + shown.width, bottom = shown.y + shown.height
  const corners: Corners = [0, 0, 0, 0]
  const reach = (index: number, radius: number, dx: number, dy: number) => {
    const x = Math.max(0, dx), y = Math.max(0, dy)
    corners[index] = Math.max(corners[index]!, radius - (x + y + Math.sqrt(2 * x * y)))
  }
  for (const box of boxes) {
    const left = shown.x - box.left, top = shown.y - box.top, end = box.right - right, foot = box.bottom - bottom
    reach(0, box.radii[0], left, top)
    reach(1, box.radii[1], end, top)
    reach(2, box.radii[2], end, foot)
    reach(3, box.radii[3], left, foot)
  }
  return corners
}

export function useBrowserSlot({ bridge, chatId, frame, active, presentation, resetKey, placeKey, vacant = false, onError }: {
  bridge: DesktopBrowserBridge | undefined
  chatId: string
  frame: RefObject<HTMLElement>
  active: boolean
  presentation: 'sidebar' | 'floating'
  resetKey?: unknown
  /**
   * Whatever can move the frame without resizing it, such as a tile trading places
   * with one of the same size. No observer sees a pure move, so a change re-measures.
   */
  placeKey?: unknown
  /** A sidebar slot's tab is blank: the slot stays with the host, the guest out of sight. */
  vacant?: boolean
  onError(reason: unknown): void
}) {
  const error = useRef(onError)
  error.current = onError
  const vacantNow = useRef(vacant)
  vacantNow.current = vacant
  const owned = useRef<symbol | null>(null)
  const remeasure = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const webviews = bridge?.webviews
    if (!active || !bridge || !webviews) return
    const slot = slots.get(bridge) ?? { owner: null, pending: Promise.resolve() }
    slots.set(bridge, slot)
    const owner = Symbol(presentation)
    slot.owner = owner
    owned.current = owner
    if (presentation !== 'sidebar') { publishFrame(webviews, null); publishFlag(webviews, 'vacant', false) }
    // Whatever is on screen belongs to the previous owner until this one's show lands.
    else { publishSettling(webviews, true); publishFlag(webviews, 'vacant', vacantNow.current) }
    let running = true
    let blocked = false
    let last = ''
    let handle = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let latest: Parameters<DesktopBrowserBridge['show']>[0] | undefined
    let queued = false
    const flush = () => {
      if (queued) return
      queued = true
      slot.pending = slot.pending.then(async () => {
        try {
          while (running && slot.owner === owner && !blocked && latest) {
            const bounds = latest
            latest = undefined
            try {
              // The third slot is the retired persistence flag, kept for positional compatibility with installed shells.
              await bridge.show(bounds, chatId, undefined, presentation)
              if (running && slot.owner === owner && presentation === 'sidebar') publishSettling(webviews, false)
            } catch (reason) {
              if (!running || slot.owner !== owner) return
              blocked = isPersistentBrowserProfileFailure(reason)
              last = ''
              error.current(reason)
              if (!blocked) retry = setTimeout(schedule, 500)
            }
          }
        } finally {
          queued = false
        }
      })
    }
    const measure = () => {
      if (!running || slot.owner !== owner) return
      const node = frame.current
      const rect = node?.getBoundingClientRect()
      if (node && rect && !blocked) {
        const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        // A frame squeezed to nothing is published too, so the guest shrinks with it
        // instead of staying clickable over the chat. The host keeps its last real size.
        // Outside the key check, since the clip can change while the frame stays put.
        // The guest follows the unrounded box, so it meets a neighbour's hairline exactly
        // at a fractional edge; only the host gets whole pixels.
        if (presentation === 'sidebar') {
          const exact = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          publishFrame(webviews, { ...exact, ...clipOf(node, exact) })
        }
        const key = JSON.stringify(bounds)
        if (key !== last) {
          last = key
          if (bounds.width > 0 && bounds.height > 0) {
            // A slow layout acknowledgement must not accumulate obsolete sizes.
            latest = bounds
            flush()
          }
        }
      }
    }
    const schedule = () => {
      if (handle || !running) return
      handle = requestAnimationFrame(() => { handle = 0; measure() })
    }
    const reassert = () => { last = ''; schedule() }
    remeasure.current = reassert
    // Measured inside the observer callback, after layout and before paint, so the guest
    // lands in the same frame as the panel instead of one animation frame behind it.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure())
    for (let node = frame.current; node; node = node.parentElement) observer?.observe(node)
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', schedule)
      window.addEventListener('scroll', schedule, true)
      window.addEventListener('focus', reassert)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('transitionend', schedule, true)
      document.addEventListener('visibilitychange', reassert)
    }
    schedule()
    return () => {
      running = false
      remeasure.current = () => {}
      if (handle) cancelAnimationFrame(handle)
      if (retry) clearTimeout(retry)
      observer?.disconnect()
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', schedule)
        window.removeEventListener('scroll', schedule, true)
        window.removeEventListener('focus', reassert)
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('transitionend', schedule, true)
        document.removeEventListener('visibilitychange', reassert)
      }
      if (slot.owner !== owner) return
      if (presentation === 'sidebar') { publishFrame(webviews, null); publishSettling(webviews, false); publishFlag(webviews, 'vacant', false) }
      slot.owner = null
      slot.pending = slot.pending.then(async () => {
        if (slot.owner === null) await bridge.hide().catch(() => {})
      })
    }
  }, [bridge, chatId, frame, active, presentation, resetKey])
  useLayoutEffect(() => remeasure.current(), [placeKey])
  useLayoutEffect(() => {
    const webviews = bridge?.webviews
    if (!bridge || !webviews || presentation !== 'sidebar' || owned.current === null) return
    if (slots.get(bridge)?.owner === owned.current) publishFlag(webviews, 'vacant', vacant)
  }, [bridge, presentation, vacant])
}
