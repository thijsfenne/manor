import { motion, useReducedMotion } from 'motion/react'
import { INSTANT, PLAN_FILL } from '../motion'

/**
 * A progress ring that fills as plan steps finish (1/4, 2/4, ...), travelling the whole
 * move on the house curve. The tasks card header and the Sessions overview draw the same
 * ring; only the size and the two stroke classes differ.
 */
export function PlanRing({ done, total, size = 15, trackClass = 'stroke-dim/40', fillClass = '', className = '' }: {
  done: number
  total: number
  size?: number
  trackClass?: string
  /** A stroke class for the fill; empty draws it in the current text colour. */
  fillClass?: string
  className?: string
}) {
  const reduce = useReducedMotion() ?? false
  const fraction = total === 0 ? 0 : done / total
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      strokeWidth={3}
      data-plan-ring={`${done}/${total}`}
      className={`-rotate-90 ${className}`}
    >
      <circle cx={12} cy={12} r={9.5} className={trackClass} />
      <motion.circle
        cx={12}
        cy={12}
        r={9.5}
        className={fillClass}
        {...(fillClass === '' ? { stroke: 'currentColor' } : {})}
        strokeLinecap="round"
        initial={false}
        animate={{ pathLength: fraction, opacity: fraction > 0 ? 1 : 0 }}
        transition={reduce ? INSTANT : PLAN_FILL}
      />
    </svg>
  )
}
