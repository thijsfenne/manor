import { useLayoutEffect, useState, type RefObject } from 'react'

/** Room to breathe around a popup: away from its trigger, and off the viewport edge. */
const GAP = 6
const INSET = 8

export interface PopupPlacement {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

interface PopupPlacementOptions {
  open: boolean
  triggerRef: RefObject<HTMLElement | null>
  /** How tall the popup may grow when there is room for it. */
  maxHeight: number
  /** Below this the list would open into a slit, so it flips above the trigger instead. */
  minHeight: number
  /** Widens a narrow trigger; the popup is never narrower than this. */
  minWidth?: number
  align?: 'start' | 'end'
}

/**
 * Where a list hangs off the control that opened it: under it by preference, above
 * it when under would be a slit, and never off an edge.
 *
 * Measured rather than assumed, and re-measured on nothing. Callers close on scroll
 * and resize (see `useDismiss`), so a position taken once cannot go stale while the
 * popup is up, and following the trigger every frame would be a repaint nobody
 * asked for.
 */
export function usePopupPlacement({
  open,
  triggerRef,
  maxHeight,
  minHeight,
  minWidth = 0,
  align = 'start',
}: PopupPlacementOptions): PopupPlacement | null {
  const [placement, setPlacement] = useState<PopupPlacement | null>(null)

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (!open || trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - GAP - INSET
    const above = rect.top - GAP - INSET
    const downward = below >= minHeight || below >= above
    const width = Math.max(minWidth, rect.width)
    setPlacement({
      left: Math.max(INSET, Math.min(align === 'end' ? rect.right - width : rect.left, window.innerWidth - width - INSET)),
      width,
      top: downward ? rect.bottom + GAP : undefined,
      bottom: downward ? undefined : window.innerHeight - rect.top + GAP,
      maxHeight: Math.min(maxHeight, downward ? below : above),
    })
  }, [open, triggerRef, maxHeight, minHeight, minWidth, align])

  return placement
}
