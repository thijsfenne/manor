import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDismiss } from './useDismiss'

const GAP = 8
const INSET = 8

/** How long the leaving card stays mounted. Matches the `project-card-out` keyframes. */
export const CARD_EXIT_MS = 90

interface HoverCardProps {
  /** Where the row is, in viewport coordinates; the card sits beside it. */
  anchor: DOMRect
  /** False once the row has let go: the card plays its exit and waits to be unmounted. */
  open: boolean
  width: number
  /**
   * The side the card opens on first; it still flips when that side has no room. `top`
   * sits over the row from its left edge, for a list too narrow to have a side.
   */
  side?: 'left' | 'right' | 'top'
  /** Names the card for screen readers, e.g. `${project.name} details`. */
  label: string
  onClose: () => void
  /** Pointer moving into the card cancels the close the row scheduled. */
  onPointerEnter: () => void
  onPointerLeave: () => void
  /** Padding and gap only; the frame, the shadow and the motion are the card's own. */
  className?: string
  children: ReactNode
}

/**
 * The shell every sidebar hover card wears (stacked above the overview popover's z-40, which
 * a card on one of its rows can overlap at narrow widths): portalled to the body so the sidebar's
 * own scroll container cannot clip it, placed beside the row it belongs to, and
 * gone the moment the layout it was measured against moves.
 *
 * It lands where it lands rather than travelling there. The fade and the few percent
 * of scale say "this opened" without making anyone wait for a card that appears
 * under the pointer while they are already reading. Cards on neighbouring rows are
 * the same gesture, so they share these keyframes rather than each picking a tempo.
 */
export function HoverCard({
  anchor,
  open,
  width,
  side = 'right',
  label,
  onClose,
  onPointerEnter,
  onPointerLeave,
  className = '',
  children,
}: HoverCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  // Off screen until measured: the flip below needs a real height, and one frame in
  // the wrong place reads as a jump.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const card = cardRef.current
    if (card === null) return
    const bounds = card.getBoundingClientRect()
    if (side === 'top') {
      const above = anchor.top - bounds.height - GAP
      const x = Math.min(anchor.left, window.innerWidth - bounds.width - INSET)
      setPosition({ x: Math.max(INSET, x), y: above >= INSET ? above : anchor.bottom + GAP })
      return
    }
    // Beside the row, on the preferred side while it fits. The sidebar is on the left,
    // so its cards default to the right; the sessions overview is on the right and asks for the left.
    const right = anchor.right + GAP
    const left = anchor.left - bounds.width - GAP
    const fitsRight = right + bounds.width + INSET <= window.innerWidth
    const x = side === 'left' ? (left >= INSET || !fitsRight ? left : right) : fitsRight ? right : left
    // Top edge flush with the row's, so the card reads as belonging to that row and
    // not to the one above it. Only a card that would fall off the bottom moves up.
    const y = Math.min(anchor.top, window.innerHeight - bounds.height - INSET)
    setPosition({ x: Math.max(INSET, x), y: Math.max(INSET, y) })
  }, [anchor, side])

  // A card that outlives the layout it was measured against points at nothing.
  useDismiss(true, onClose, { layoutMoved: true, scrollsInside: cardRef, escape: true, windowBlur: true })

  // Held back until the card knows where it goes, so the fade cannot run against the
  // off-screen first frame. The layout effect above settles that before the paint.
  const motion =
    position === null
      ? ''
      : open
        ? 'motion-safe:animate-[project-card-in_120ms_ease-out]'
        : 'pointer-events-none motion-safe:animate-[project-card-out_90ms_ease-in_forwards]'

  return createPortal(
    <div
      ref={cardRef}
      className={`fixed z-[45] flex flex-col gap-2 rounded-xl border border-line surface-floating shadow-popover ${className} ${motion}`}
      style={{
        width,
        left: position?.x ?? -9999,
        top: position?.y ?? -9999,
        visibility: position === null ? 'hidden' : 'visible',
        // It grows out of the edge that faces its row, whichever side it flipped to.
        transformOrigin: side === 'top'
          ? (position !== null && position.y < anchor.top ? 'left bottom' : 'left top')
          : position !== null && position.x < anchor.left ? 'right center' : 'left center',
      }}
      role="dialog"
      data-hover-card=""
      aria-label={label}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>,
    document.body,
  )
}
