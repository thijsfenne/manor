import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ICON_SWAP, ICON_SWAP_GONE, ICON_SWAP_REST } from '../../motion'

interface IconSwapProps {
  /** What the mark stands for right now. A new value is what runs the swap. */
  swapKey: string
  className?: string
  children: ReactNode
}

/**
 * One slot, two marks that mean different things: the composer's send arrow becoming
 * a stop square, the theme button walking sun to moon to screen. `transitions.dev`'s
 * icon swap (09-icon-swap), which shrinks the outgoing mark away under blur while the
 * incoming one comes up the same path, so the two read as one thing changing rather
 * than as two things taking turns.
 *
 * Both marks sit in the same grid cell for the length of the swap, which is what keeps
 * the button from resizing or the row from shifting. 200ms rather than the snippet's
 * 250, on the same curve as the popovers: this is a mark the size of a thumbnail and
 * it should be done by the time you have finished pressing it.
 */
export function IconSwap({ swapKey, className = '', children }: IconSwapProps) {
  const reduce = useReducedMotion() ?? false
  return (
    <span className={`grid place-items-center ${className}`}>
      <AnimatePresence initial={false}>
        <motion.span
          key={swapKey}
          className="col-start-1 row-start-1 flex items-center justify-center"
          initial={reduce ? { opacity: 0 } : ICON_SWAP_GONE}
          animate={ICON_SWAP_REST}
          exit={reduce ? { opacity: 0 } : ICON_SWAP_GONE}
          transition={reduce ? { duration: 0.1 } : ICON_SWAP}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
