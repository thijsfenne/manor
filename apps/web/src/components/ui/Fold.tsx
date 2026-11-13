import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { motion, useReducedMotion, type Variants } from 'motion/react'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { INSTANT, SPRING_CHEVRON, SUBMENU_ITEM_VARIANTS, SUBMENU_VARIANTS } from '../../motion'
import { Icon } from '../Icon'

/**
 * A section of the sidebar folding away. Wrap the contents, hand it the state the
 * header button already holds, and the list grows out of that header instead of
 * appearing next to it.
 *
 * The contents stay mounted whether or not they are open, because a list that
 * unmounts cannot be folded away, it can only vanish. That has one consequence
 * worth knowing at the call site: rows inside a closed fold are still in the tree.
 * They are out of the tab order and hidden from screen readers (see `.fold` in
 * styles.css), but anything counting DOM nodes is counting these too, so a fold is
 * for a list that is already bounded rather than one that grows without limit.
 *
 * The inner wrapper is the part that clips, and it is not optional: it is what
 * lets the grid track collapse at all.
 */
export function Fold({ open, children, className = '' }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={`fold ${className}`} data-open={open}>
      <div>{children}</div>
    </div>
  )
}

/** The same 90° turn Routines, Settled and Archived share. */
export function FoldChevron({ open }: { open: boolean }) {
  const reduce = useReducedMotion() ?? false
  return (
    <motion.span
      className="grid place-items-center"
      initial={false}
      animate={{ rotate: open ? 90 : 0 }}
      transition={reduce ? INSTANT : SPRING_CHEVRON}
    >
      <Icon icon={ArrowRight01Icon} size={13} />
    </motion.span>
  )
}

/**
 * A fold whose list wipes and staggers. Height still belongs to `Fold`; the
 * clip-path and the child rise are the beUI submenu on top of it.
 */
export function FoldList({
  open,
  className = '',
  frameClassName = '',
  variants = SUBMENU_VARIANTS,
  children,
}: {
  open: boolean
  className?: string
  /** Placement for the folding frame itself; `className` styles the list inside. */
  frameClassName?: string
  /** The list's wipe and stagger; the submenu's unless a list needs its own pace. */
  variants?: Variants
  children: ReactNode
}) {
  const reduce = useReducedMotion() ?? false
  return (
    <Fold open={open} className={frameClassName}>
      <motion.ul
        className={className}
        initial={false}
        variants={reduce ? undefined : variants}
        animate={open ? 'open' : 'closed'}
      >
        {children}
      </motion.ul>
    </Fold>
  )
}

export const FoldItem = forwardRef<HTMLLIElement, ComponentPropsWithoutRef<typeof motion.li>>(
  function FoldItem({ children, ...rest }, ref) {
    const reduce = useReducedMotion() ?? false
    return (
      <motion.li ref={ref} {...rest} variants={reduce ? undefined : SUBMENU_ITEM_VARIANTS}>
        {children}
      </motion.li>
    )
  },
)
