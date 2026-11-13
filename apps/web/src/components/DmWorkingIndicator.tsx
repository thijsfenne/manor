import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { AgentConfig } from '@manor/contracts'
import { personaOf, type Persona } from '../state'
import { dmWorkingLabel, type DmWorking } from '../turnTrace'
import { INSTANT, TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../motion'
import { TurnHeader } from './Bubbles'
import { useNowSecond } from '../useNowSecond'

/** A label stays at least this long, so a run of quick calls cannot make it flicker. */
const LABEL_HOLD_MS = 2_500

/**
 * A DM's one sign of life: her face and a shimmering label at the foot of the chat,
 * under the last message, from the send until her reply is whole. Finished bubbles
 * carry no face; this is the only place it appears. It leaves the moment the reply
 * lands, is stopped or breaks off, without a word about why.
 */
export function DmWorkingIndicator({ working, persona, agents }: {
  working: DmWorking
  persona: Persona
  agents: AgentConfig[]
}) {
  const reduce = useReducedMotion() ?? false
  const now = useNowSecond()
  const label = working.kind === 'consult'
    ? `Waiting for ${personaOf(agents, working.peerAgentId).name}…`
    : dmWorkingLabel(working.kind === 'turn' ? working.turn : undefined, now)
  const shown = useHeldLabel(label)
  return (
    <motion.div
      data-dm-working=""
      role="status"
      className="-mt-3"
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? INSTANT : TEXT_SWAP}
    >
      <TurnHeader
        quiet
        working
        name={persona.name}
        color={persona.color}
        avatar={persona.avatar}
        avatarShape={persona.avatarShape}
        avatarTone={persona.avatarTone}
        status={
          <span className="relative min-w-0 truncate text-[15px] leading-tight font-normal">
            {/* Keyed by the words, so a new phase swaps in place, the way the status line does. */}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={shown}
                className="shimmer-text"
                data-text={shown}
                initial={reduce ? false : TEXT_SWAP_BELOW}
                animate={TEXT_SWAP_REST}
                exit={reduce ? { opacity: 0 } : TEXT_SWAP_ABOVE}
                transition={reduce ? INSTANT : TEXT_SWAP}
              >
                {shown}
              </motion.span>
            </AnimatePresence>
          </span>
        }
      />
    </motion.div>
  )
}

/** The newest label, but never sooner than `LABEL_HOLD_MS` after the last change. */
function useHeldLabel(label: string): string {
  const [shown, setShown] = useState(label)
  const since = useRef(0)
  useEffect(() => {
    if (label === shown) return undefined
    const wait = since.current + LABEL_HOLD_MS - Date.now()
    const apply = () => {
      since.current = Date.now()
      setShown(label)
    }
    if (wait <= 0) {
      apply()
      return undefined
    }
    const timer = window.setTimeout(apply, wait)
    return () => window.clearTimeout(timer)
  }, [label, shown])
  return shown
}
