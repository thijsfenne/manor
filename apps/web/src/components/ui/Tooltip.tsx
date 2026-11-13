import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { EASE_OUT, INSTANT } from '../../motion'
import { useDismiss } from './useDismiss'

/** Kept off the window edges, and off the thing it points at. */
const INSET = 8
const GAP = 6

interface TooltipProps {
  /** The element this card explains. Mounting it is what opens it; there is no open flag. */
  anchor: HTMLElement
  /** The caller puts this on the anchor's aria-describedby, so the text is read, not just seen. */
  id: string
  /** Hover left, focus moved, the page scrolled: the anchor is no longer where it was. */
  onDismiss: () => void
  children: ReactNode
}

/**
 * A small explanation that follows the pointer's target rather than the layout,
 * portalled to the body so a scrolling dialog cannot clip it. It prefers the space
 * above the anchor and flips below when there isn't any, and it never takes the
 * pointer: a tooltip that can be hovered is a tooltip that flickers.
 *
 * Mount it only while it should be visible, and hand it the element it belongs to.
 */
export function Tooltip({ anchor, id, onDismiss, children }: TooltipProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion() ?? false
  // Placed after one measured pass, because centring and flipping both need the
  // card's own size. Until then it is rendered but not shown, never shown wrong.
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const card = cardRef.current
    if (card === null) return
    const target = anchor.getBoundingClientRect()
    const box = card.getBoundingClientRect()
    const above = target.top - GAP - box.height
    const left = Math.max(
      INSET,
      Math.min(target.left + target.width / 2 - box.width / 2, window.innerWidth - box.width - INSET),
    )
    const top = above >= INSET ? above : Math.min(target.bottom + GAP, window.innerHeight - box.height - INSET)
    // Same numbers, same object: a card that re-renders itself into a new position
    // every parent render is a repaint nobody asked for.
    setPlacement((current) =>
      current !== null && current.left === left && current.top === top ? current : { left, top },
    )
  }, [anchor, children])

  // A fixed card cannot follow a scrolling anchor, so it leaves instead of lying
  // about what it points at.
  useDismiss(true, onDismiss, { layoutMoved: true })

  const shown = placement !== null
  return createPortal(
    <motion.div
      ref={cardRef}
      className="pointer-events-none fixed z-30 max-w-[300px] rounded-lg border border-line bg-raised px-2.5 py-2 text-label leading-relaxed text-muted shadow-popover"
      style={{ left: placement?.left ?? 0, top: placement?.top ?? 0 }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0 }}
      transition={reduce ? INSTANT : { duration: 0.16, ease: EASE_OUT }}
      role="tooltip"
      id={id}
    >
      {children}
    </motion.div>,
    document.body,
  )
}
