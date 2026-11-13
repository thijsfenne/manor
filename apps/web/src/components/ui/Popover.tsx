import { forwardRef, useEffect, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useStableCallback } from '../../useStableCallback'
import {
  POPOVER_CLOSING_SCALE,
  POPOVER_IN,
  POPOVER_OUT,
  POPOVER_PRE_SCALE,
  POPOVER_TRAVEL,
} from '../../motion'

/**
 * The edge the sheet grows out of: the one nearest the control that opened it. A corner
 * where the sheet hangs off one end of its trigger, the bare edge where it is centred
 * on it or wider than it, which is when growing out of a corner reads as lopsided.
 */
type Origin = 'bottom-left' | 'bottom-right' | 'bottom' | 'top-left' | 'top-right' | 'top'

interface PopoverProps {
  open: boolean
  onReady?(): void
  origin?: Origin
  /** `ul` where the rows are real list items; the content box is then the list itself. */
  element?: 'div' | 'ul'
  /** The card: where it hangs, how big it is, what it looks like. */
  className?: string
  /** Measured position, for the callers that portal and place themselves. */
  style?: CSSProperties
  /** The content box inside it. Carries any layout the children depend on. */
  contentClassName?: string
  role?: string
  id?: string
  'aria-label'?: string
  children: ReactNode
}

/**
 * A sheet hanging off the control that opened it: the composer's plus menu, its
 * runtime and checkout menus, the mention list, the context readout. Positioning,
 * dismissal and the card's own look stay with the caller, because those differ per
 * menu; what is shared is the way it arrives.
 *
 * It grows from the edge nearest its trigger, which is `transitions.dev`'s dropdown
 * (05-menu-dropdown): 0.97 up to 1 opening, 0.99 closing. 200ms in rather than their
 * 250, and on `EASE_TRAVEL` rather than either their curve or the house one, for the
 * reason written at that constant: a decelerating curve finishes this move before it
 * can be read.
 *
 * Two boxes rather than one, which is where this departs from the recipe. Scaling a
 * card scales everything in it, and at 3% across a 340px panel the far rows travel ten
 * pixels while the near ones sit still, so the list appears to stretch and the type
 * resamples on the way. The content box runs the inverse scale on the same curve, so
 * the card grows and nothing inside it moves; the two multiply back to within a
 * fiftieth of a percent of 1 for the whole ride, a hundredth of a pixel at these sizes.
 *
 * That cancellation is also why the card travels. With the content held still, the
 * only thing left growing is a border a few pixels out, which on a dark surface is not
 * a move anyone sees: the first cut of this read as a plain fade. The travel is on the
 * card, so every row moves the same distance in the same direction, which is legible
 * from across the screen and still cannot smear the list.
 *
 * Usually anchored inside the caller's own relative wrapper. A popup that has to
 * escape an overflow measures itself instead and portals to the body; it passes that
 * measurement as `style` and keeps `origin` pointing at whichever side it landed on.
 */
export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover({
  open,
  onReady,
  origin = 'bottom-left',
  element = 'div',
  className,
  style,
  contentClassName,
  role,
  id,
  'aria-label': ariaLabel,
  children,
}, ref) {
  const reduce = useReducedMotion() ?? false
  const ready = useStableCallback(() => onReady?.())
  useEffect(() => { if (open) ready() }, [open, ready])
  const transformOrigin = origin.replace('-', ' ')
  // Out of the trigger and away from it. The card carries this, so the rows ride it as
  // one block: a rigid move is the one kind of travel that cannot smear a list.
  const travel = origin.startsWith('bottom') ? POPOVER_TRAVEL : -POPOVER_TRAVEL

  const content = {
    id,
    role,
    'aria-label': ariaLabel,
    className: contentClassName,
    style: { transformOrigin },
    initial: reduce ? false : { scale: 1 / POPOVER_PRE_SCALE },
    animate: { scale: 1 },
    exit: reduce ? {} : { scale: 1 / POPOVER_CLOSING_SCALE, transition: POPOVER_OUT },
    transition: reduce ? { duration: 0 } : POPOVER_IN,
    children,
  }

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          className={className}
          style={{ ...style, transformOrigin }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: POPOVER_PRE_SCALE, y: travel }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={
            reduce
              ? { opacity: 0, transition: { duration: 0.1 } }
              : { opacity: 0, scale: POPOVER_CLOSING_SCALE, y: travel / 2, transition: POPOVER_OUT }
          }
          transition={reduce ? { duration: 0.12 } : POPOVER_IN}
        >
          {element === 'ul' ? <motion.ul {...content} /> : <motion.div {...content} />}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
})
