import { motion, useReducedMotion } from 'motion/react'
import { INSTANT, SEGMENTED_SLIDE } from '../../motion'

/**
 * The one travelling fill the sidebar's chat lists share. Named rather than typed at
 * each call site, because the inbox list and the messaging list are the same slot and
 * a mismatched id would make the fill blink instead of travel.
 */
export const SIDEBAR_ROW_MARKER = 'sidebar-row'

/**
 * The navigation rail's doors, which are a second group on purpose: a fill flying
 * from a door into a chat row would cross into the sidebar, and a DM draft can light
 * a chat row while a door is current, which would leave two claims on one surface.
 */
export const SIDEBAR_NAV_MARKER = 'sidebar-nav'

/**
 * The selected fill as one surface that travels, rather than a class that switches
 * off on one row and on at another. Two rows lighting in the same frame reads as a
 * jump cut; a fill that slides says which row you left and which one you landed on.
 *
 * It is the same move the segmented control makes, on the same curve, and it comes
 * with the same rule: only one marker per `layoutId` may be mounted at a time, so a
 * list that could hold two selected rows picks one and marks that.
 *
 * Sits behind the row's content, so the caller's row needs `relative` and its
 * content needs to be positioned or ordered after this. The radius belongs to the
 * row, not here, because a marker that rounded itself would fit only one list.
 */
export function SelectionMarker({
  layoutId,
  layoutDependency,
  className = '',
}: {
  layoutId: string
  layoutDependency?: unknown
  className?: string
}) {
  const reduceMotion = useReducedMotion() ?? false
  return (
    <motion.span
      aria-hidden
      layoutId={layoutId}
      layoutDependency={layoutDependency}
      className={`pointer-events-none absolute inset-0 bg-user-bg ${className}`}
      transition={reduceMotion ? INSTANT : SEGMENTED_SLIDE}
    />
  )
}
