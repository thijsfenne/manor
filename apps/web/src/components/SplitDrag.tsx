import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { EASE_OUT, INSTANT } from '../motion'
import { RIGHT_PANEL_MOTION_MS, type TileBox } from '../useRightPanel'
import { swallowReleaseClick } from './TileDrag'

/**
 * What a drag carries onto the stage: a thread, a fresh session, or an agent, whose
 * DM opens beside the stage, or a DM draft when she has none yet.
 */
export type SplitDragItem = { kind: 'chat'; chatId: string } | { kind: 'agent'; agentId: string } | { kind: 'new' }

/** Where a drop is taken (`area`) and the pane it would open (`box`), on screen. */
export interface SplitDropTarget {
  area: DOMRect
  box: TileBox
}

interface Dragging {
  item: SplitDragItem
  ghost: HTMLElement
  width: number
  height: number
  over: TileBox | null
}

/** How far a press travels before it is a drag rather than a click, as for panel tiles. */
const DRAG_THRESHOLD = 4

/**
 * One sidebar-to-stage drag at a time. The stage says where it takes a drop through
 * `target` and what a drop does through `onDrop`, both read at the moment they are
 * needed, so the workspace never re-renders while the pointer moves: only the layer
 * subscribes, and the ghost follows the pointer by style alone.
 */
export function createSplitDrag() {
  let state: Dragging | null = null
  const listeners = new Set<() => void>()
  const set = (next: Dragging | null) => {
    state = next
    for (const listener of listeners) listener()
  }
  let pointer = { x: 0, y: 0, dx: 0, dy: 0 }

  const drag = {
    target: null as (() => SplitDropTarget | null) | null,
    onDrop: (_item: SplitDragItem) => {},
    holder: null as HTMLElement | null,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    snapshot: () => state,
    place() {
      if (drag.holder !== null) drag.holder.style.transform = `translate(${pointer.x - pointer.dx}px, ${pointer.y - pointer.dy}px)`
    },
    /** A source's pointer-down. Nothing starts until the pointer has moved a few pixels. */
    grab(item: SplitDragItem, event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || state !== null) return
      const source = event.currentTarget
      const { pointerId } = event
      const origin = { x: event.clientX, y: event.clientY }
      const body = document.body.style
      const restore = { cursor: body.cursor, userSelect: body.userSelect }
      let live = false

      const move = (moved: PointerEvent) => {
        if (moved.pointerId !== pointerId) return
        if (!live) {
          if (Math.hypot(moved.clientX - origin.x, moved.clientY - origin.y) < DRAG_THRESHOLD) return
          live = true
          body.cursor = 'grabbing'
          body.userSelect = 'none'
          window.getSelection()?.removeAllRanges()
          // The press focused the row's button; a drag is not a visit, so it leaves no ring behind.
          if (document.activeElement instanceof HTMLElement && source.contains(document.activeElement)) document.activeElement.blur()
          const rect = source.getBoundingClientRect()
          pointer = { x: moved.clientX, y: moved.clientY, dx: origin.x - rect.left, dy: origin.y - rect.top }
          // The card as it is drawn, and only the card: its own spacing to the next row stays behind.
          const ghost = source.cloneNode(true) as HTMLElement
          ghost.style.margin = '0'
          set({ item, ghost, width: rect.width, height: rect.height, over: null })
        }
        moved.preventDefault()
        pointer = { ...pointer, x: moved.clientX, y: moved.clientY }
        drag.place()
        const target = drag.target?.() ?? null
        const inside = target !== null && moved.clientX >= target.area.left && moved.clientX < target.area.right
          && moved.clientY >= target.area.top && moved.clientY < target.area.bottom
        const over = inside ? target.box : null
        if (state !== null && !sameBox(state.over, over)) set({ ...state, over })
      }
      const end = (how: 'drop' | 'cancel' | 'lost') => {
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', up, true)
        window.removeEventListener('pointercancel', lost, true)
        window.removeEventListener('keydown', key, true)
        window.removeEventListener('blur', cancel)
        if (!live) return
        const landed = state?.over ?? null
        body.cursor = restore.cursor
        body.userSelect = restore.userSelect
        set(null)
        if (how === 'drop' && landed !== null) drag.onDrop(item)
        if (how !== 'lost') swallowReleaseClick(window, pointerId, how === 'drop')
      }
      const up = (released: PointerEvent) => {
        if (released.pointerId === pointerId) end('drop')
      }
      const cancel = () => end('cancel')
      const lost = (lostEvent: PointerEvent) => {
        if (lostEvent.pointerId === pointerId) end('lost')
      }
      const key = (pressed: KeyboardEvent) => {
        if (pressed.key !== 'Escape') return
        if (live) {
          pressed.preventDefault()
          pressed.stopPropagation()
        }
        end('cancel')
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', up, true)
      window.addEventListener('pointercancel', lost, true)
      window.addEventListener('keydown', key, true)
      window.addEventListener('blur', cancel)
    },
  }
  return drag
}

export type SplitDrag = ReturnType<typeof createSplitDrag>

const sameBox = (a: TileBox | null, b: TileBox | null) =>
  a === b || (a !== null && b !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)

/** The workspace's one drag, stable for its lifetime. */
export function useSplitDrag() {
  const [drag] = useState(createSplitDrag)
  return drag
}

/** A sidebar source's way to start the drag; null where nothing can open beside the stage. */
export const SplitDragContext = createContext<SplitDrag['grab'] | null>(null)
export const useSplitDragGrab = () => useContext(SplitDragContext)

/**
 * The card under the pointer and the pane it would open, drawn over everything the
 * way a panel tile's landing is: on the body above the browser's page layer, which
 * lets the pointer through (`data-panel-resizing`) while it is up.
 */
export function SplitDragLayer({ drag }: { drag: SplitDrag }) {
  const state = useSyncExternalStore(drag.subscribe, drag.snapshot, drag.snapshot)
  const reduce = useReducedMotion() ?? false
  const holder = useRef<HTMLDivElement>(null)
  const ghost = state?.ghost ?? null

  useLayoutEffect(() => {
    const element = holder.current
    if (element === null || ghost === null) return
    element.replaceChildren(ghost)
    drag.holder = element
    drag.place()
    return () => {
      drag.holder = null
    }
  }, [drag, ghost])

  if (state === null || typeof document === 'undefined') return null
  const transition = reduce ? INSTANT : { duration: RIGHT_PANEL_MOTION_MS / 1000, ease: EASE_OUT }
  const box = state.over
  return createPortal(
    <div data-panel-resizing="" aria-hidden className="pointer-events-none fixed inset-0" style={{ zIndex: 'var(--z-panel-drag)' }}>
      {/* The pane, then the card, then the pill: the card under the pointer never hides the words. */}
      <AnimatePresence>
        {box === null ? null : (
          <motion.div
            key="pane"
            className="absolute top-0 left-0 rounded-2xl border-2 border-primary/40 bg-primary/10"
            initial={{ opacity: 0, x: box.left, y: box.top, width: box.width, height: box.height }}
            animate={{ opacity: 1, x: box.left, y: box.top, width: box.width, height: box.height }}
            exit={{ opacity: 0 }}
            transition={transition}
          />
        )}
      </AnimatePresence>
      <div
        ref={holder}
        className="absolute top-0 left-0 overflow-hidden rounded-lg bg-surface-2"
        style={{ width: state.width, height: state.height }}
      />
      <AnimatePresence>
        {box === null ? null : (
          <motion.div
            key="pill"
            className="absolute top-0 left-0 grid place-items-center"
            initial={{ opacity: 0, x: box.left, y: box.top, width: box.width, height: box.height }}
            animate={{ opacity: 1, x: box.left, y: box.top, width: box.width, height: box.height }}
            exit={{ opacity: 0 }}
            transition={transition}
          >
            <span className="flex h-9 items-center rounded-full bg-primary px-4 text-[14px] font-medium whitespace-nowrap text-on-primary">
              Open in split view
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  )
}
