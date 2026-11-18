import { motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { digitKeys } from '../../digitKeys'
import { DIGIT_POP, DIGIT_POP_REST, DIGIT_POP_TRAVEL, INSTANT } from '../../motion'

/**
 * A signed count that ticks while you watch it, such as a running turn's +added and
 * −removed. The digits that changed pop into place; the rest stay put. A first render
 * shows the number still, so a count belonging to another chat mounts afresh (its
 * owner is keyed by chat). Assistive technology reads the whole count as one string.
 */
export function PopDigits({ value, prefix }: { value: number; prefix: string }) {
  const reduce = useReducedMotion() ?? false
  // The count before this one; undefined until it first changes.
  const [seen, setSeen] = useState<{ value: number; before?: number }>({ value })
  let before = seen.before
  if (seen.value !== value) {
    before = seen.value
    setSeen({ value, before })
  }
  const held = new Set(before === undefined ? digitKeys(value) : digitKeys(before))
  const from = { opacity: 0, y: DIGIT_POP_TRAVEL * (before === undefined || value > before ? 1 : -1), filter: 'blur(2px)' }
  const keys = digitKeys(value)
  return (
    <>
      <span className="sr-only">{prefix}{value}</span>
      <span aria-hidden="true">
        {prefix}
        {[...String(value)].map((digit, index) => (
          <motion.span
            key={keys[index]}
            className="inline-block"
            initial={reduce || held.has(keys[index]!) ? false : from}
            animate={DIGIT_POP_REST}
            transition={reduce ? INSTANT : DIGIT_POP}
          >
            {digit}
          </motion.span>
        ))}
      </span>
    </>
  )
}
