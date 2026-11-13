import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { EASE_OUT, INSTANT } from '../motion'
import { RIGHT_PANEL_MOTION_MS, dropAt, movedPanel, type PanelDrop, type PanelLayout, type RightPanelId, type TileBox } from '../useRightPanel'
import { DOCK_PANEL_SHELL } from './ui/dockPanel'

/** How far a press on a tile's head travels before it is a drag rather than a click. */
const DRAG_THRESHOLD = 4
/** The head every panel draws at the top of its card, `h-11`. */
const GRIP_HEIGHT = 44
/** A panel's card, found by the shell class every docked panel draws. */
const CARD = DOCK_PANEL_SHELL.split(' ').map((name) => `.${name}`).join('')
/** Places in a head that keep the pointer for themselves: text to type or select, a resize edge. */
const NOT_A_GRIP = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="separator"]'

export interface TileLanding {
  target: RightPanelId
  drop: PanelDrop
  box: TileBox
}

const cardOf = (cell: HTMLElement) => cell.querySelector<HTMLElement>(CARD) ?? cell
const boxOf = (element: HTMLElement): TileBox => {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

type Measured = Pick<HTMLElement, 'getBoundingClientRect'> & { parentElement: Pick<HTMLElement, 'getBoundingClientRect'> | null }

/**
 * The tile under the pointer, other than the one being dragged. A tile counts only
 * where it is in view: a floating row that scrolls clips its cells to its own box,
 * and the part scrolled out of view may lie over the other pane of a split Work.
 * The cell rather than its card, so the gutter between two tiles is not a gap the
 * preview blinks out in.
 */
export function tileUnder<Cell extends Measured>(cells: ReadonlyMap<RightPanelId, Cell>, dragged: RightPanelId, x: number, y: number) {
  for (const [target, cell] of cells) {
    if (target === dragged) continue
    const area = cell.getBoundingClientRect()
    const row = cell.parentElement?.getBoundingClientRect() ?? area
    const left = Math.max(area.left, row.left), right = Math.min(area.right, row.right)
    const top = Math.max(area.top, row.top), bottom = Math.min(area.bottom, row.bottom)
    if (x >= left && x < right && y >= top && y < bottom) return { target, cell }
  }
  return null
}

/**
 * The landing a drag shows at the pointer. A tile under it says where the panel goes;
 * off the tiles, the landing already shown holds while the pointer stays inside its
 * box. A drop that opens a column previews it beside the row, over the chat where no
 * tile is, and the whole preview is the place to let go.
 */
export function landingUnder(over: TileLanding | null, shown: TileLanding | null, x: number, y: number) {
  if (over !== null || shown === null) return over
  const { left, top, width, height } = shown.box
  return x >= left && x < left + width && y >= top && y < top + height ? shown : null
}

/**
 * Eats the click the release of `pointerId` fires, and only that one: the release that
 * ends a drag would otherwise click the button the grab began on. `released` is a
 * release already under way. Otherwise the pointer is still down, as after an Escape
 * mid-drag, and it waits for the release; a press that comes first means the window
 * never saw that release, so it stands down rather than eat a real click.
 */
export function swallowReleaseClick(target: EventTarget, pointerId: number, released: boolean) {
  // An options object rather than `true`: Node's EventTarget, which the tests run on,
  // does not match a boolean capture on removal.
  const CAPTURE = { capture: true }
  const swallow = (event: Event) => {
    event.stopPropagation()
    event.preventDefault()
  }
  const arm = () => {
    target.addEventListener('click', swallow, { ...CAPTURE, once: true })
    setTimeout(() => target.removeEventListener('click', swallow, CAPTURE), 0)
  }
  if (released) {
    arm()
    return
  }
  const up = (event: Event) => {
    if ((event as PointerEvent).pointerId !== pointerId) return
    done()
    arm()
  }
  const done = () => {
    target.removeEventListener('pointerup', up, CAPTURE)
    target.removeEventListener('pointerdown', done, CAPTURE)
    target.removeEventListener('pointercancel', done, CAPTURE)
  }
  target.addEventListener('pointerup', up, CAPTURE)
  target.addEventListener('pointerdown', done, CAPTURE)
  target.addEventListener('pointercancel', done, CAPTURE)
}

/**
 * Rearranging the tiles by their heads. A press on the top band of a card starts
 * nothing until it has moved a few pixels, so the close and expand buttons there keep
 * their click. While it moves, the tile under the pointer says where the panel would
 * land (`landing`); letting go there moves it, letting go anywhere else or pressing
 * Escape leaves the layout as it was. Only this region's own tiles are targets, so
 * the two panes of a split Work never trade panels.
 */
export function useTileDrag({ layout, enabled, onMove, place }: {
  layout: PanelLayout
  enabled: boolean
  onMove: (id: RightPanelId, target: RightPanelId, drop: PanelDrop) => void
  /** Where a panel's card will be drawn in a layout, on screen, sized the way the region sizes it. */
  place: (layout: PanelLayout, id: RightPanelId) => TileBox | null
}) {
  const cells = useRef(new Map<RightPanelId, HTMLElement>())
  const [dragging, setDragging] = useState<RightPanelId | null>(null)
  const [landing, setLanding] = useState<TileLanding | null>(null)
  const stop = useRef<(() => void) | null>(null)
  const latest = useRef({ layout, onMove, place })
  latest.current = { layout, onMove, place }

  const cellRef = useCallback((id: RightPanelId) => (node: HTMLElement | null) => {
    if (node === null) cells.current.delete(id)
    else cells.current.set(id, node)
  }, [])

  // A layout that stops offering the drag mid-gesture, an expand or a panel closing
  // under it, ends the gesture rather than leaving the pointer holding nothing.
  useEffect(() => {
    if (!enabled) stop.current?.()
  }, [enabled])
  useEffect(() => () => stop.current?.(), [])

  /** The drop under the pointer, and the card the panel would have once it lands. */
  const landingAt = (id: RightPanelId, x: number, y: number): TileLanding | null => {
    const under = tileUnder(cells.current, id, x, y)
    if (under === null) return null
    const { target, cell } = under
    const card = boxOf(cardOf(cell))
    const { layout, place } = latest.current
    const drop = dropAt(layout, id, target, (x - card.left) / card.width, (y - card.top) / card.height)
    const box = drop === null ? null : place(movedPanel(layout, id, target, drop), id)
    return drop === null || box === null ? null : { target, drop, box }
  }

  /** A tile's pointer-down, in the capture phase so a button in the head cannot keep it. */
  const grab = (id: RightPanelId, event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || stop.current !== null) return
    const card = cardOf(event.currentTarget)
    const target = event.target as Element
    const top = card.getBoundingClientRect().top
    if (event.clientY < top || event.clientY >= top + GRIP_HEIGHT || !card.contains(target) || target.closest(NOT_A_GRIP) !== null) return
    begin(id, event.pointerId, event.clientX, event.clientY)
  }

  const begin = (id: RightPanelId, pointerId: number, originX: number, originY: number) => {
    let live = false
    let current: TileLanding | null = null
    const body = document.body.style
    const restore = { cursor: body.cursor, userSelect: body.userSelect }

    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      if (!live) {
        if (Math.hypot(event.clientX - originX, event.clientY - originY) < DRAG_THRESHOLD) return
        live = true
        body.cursor = 'grabbing'
        body.userSelect = 'none'
        window.getSelection()?.removeAllRanges()
        setDragging(id)
      }
      event.preventDefault()
      current = landingUnder(landingAt(id, event.clientX, event.clientY), current, event.clientX, event.clientY)
      setLanding(current)
    }
    /** `drop` is a release, `cancel` a pointer still down (Escape, blur), `lost` one the browser took away. */
    const end = (how: 'drop' | 'cancel' | 'lost') => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', lost, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', cancel)
      stop.current = null
      if (!live) return
      body.cursor = restore.cursor
      body.userSelect = restore.userSelect
      setDragging(null)
      setLanding(null)
      if (how === 'drop' && current !== null) latest.current.onMove(id, current.target, current.drop)
      if (how !== 'lost') swallowReleaseClick(window, pointerId, how === 'drop')
    }
    const up = (event: PointerEvent) => {
      if (event.pointerId === pointerId) end('drop')
    }
    const cancel = () => end('cancel')
    const lost = (event: PointerEvent) => {
      if (event.pointerId === pointerId) end('lost')
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (live) {
        event.preventDefault()
        event.stopPropagation()
      }
      end('cancel')
    }

    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', lost, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', cancel)
    stop.current = cancel
  }

  return { dragging, landing, cellRef, grab }
}

/**
 * Where the dragged panel would land, drawn over everything. It lives on the body
 * above the browser's page layer, which paints over the whole region and would
 * otherwise hide a preview aimed at its tile; while it is up the page also lets the
 * pointer through (`data-panel-resizing`), as it does for a resize.
 */
export function TileDropPreview({ dragging, landing }: { dragging: RightPanelId | null; landing: TileLanding | null }) {
  const reduce = useReducedMotion() ?? false
  if (dragging === null || typeof document === 'undefined') return null
  const transition = reduce ? INSTANT : { duration: RIGHT_PANEL_MOTION_MS / 1000, ease: EASE_OUT }
  return createPortal(
    <div data-panel-resizing="" aria-hidden className="pointer-events-none fixed inset-0" style={{ zIndex: 'var(--z-panel-drag)' }}>
      <AnimatePresence>
        {landing === null ? null : (
          <motion.div
            key="landing"
            className="absolute top-0 left-0 rounded-dock border-2 border-primary/40 bg-primary/10"
            initial={{ opacity: 0, x: landing.box.left, y: landing.box.top, width: landing.box.width, height: landing.box.height }}
            animate={{ opacity: 1, x: landing.box.left, y: landing.box.top, width: landing.box.width, height: landing.box.height }}
            exit={{ opacity: 0 }}
            transition={transition}
          />
        )}
      </AnimatePresence>
    </div>,
    document.body,
  )
}
