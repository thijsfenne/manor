import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { LoaderCircleIcon } from '@hugeicons/core-free-icons'
import { INSTANT, TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../../motion'
import { relativeTime } from '../../relativeTime'
import { Icon } from '../Icon'

const STATUS_MARK_SIZE = 16

/**
 * Where a live chat stands when nothing is hovering it. Three levels of loud,
 * because they are three different claims on attention: a turn in flight, an answer
 * nobody has read, and a chat that is simply this old. Static text, never a pulse.
 *
 * Shared by the Work inbox and the DM list, so a running turn and an unread answer
 * read the same wherever the chat is listed.
 */
export function Standing({
  waiting,
  unread,
  running,
  lastMessageAt,
  now,
}: {
  waiting: boolean
  unread: boolean
  running: boolean
  /** Null for a chat nobody has started yet, which says nothing rather than inventing a time. */
  lastMessageAt: number | null
  now: number
}) {
  const reduce = useReducedMotion() ?? false

  // A fourth, and the loudest of them: the turn is running but it is standing still
  // until the user answers a question, which is a claim on them rather than on their patience.
  const state = waiting ? 'waiting' : running ? 'running' : unread ? 'unread' : 'quiet'
  const mark = state === 'running' || state === 'unread'
  const face =
    state === 'waiting' ? (
      <span className="text-[12px] font-medium text-warn">Waiting</span>
    ) : state === 'running' ? (
      <Icon
        icon={LoaderCircleIcon}
        size={STATUS_MARK_SIZE}
        className="block size-4 flex-none motion-safe:animate-spin-calm"
      />
    ) : state === 'unread' ? (
      <span className="block size-1.5 rounded-full bg-ok" />
    ) : lastMessageAt === null ? null : (
      <span className="text-[12px] tabular-nums">{relativeTime(lastMessageAt, now)}</span>
    )

  return (
    // Keyed on the state and never on the words: the quiet row re-reads its own clock
    // every minute, and a row that swapped on that would twitch once a minute to say
    // nothing. One leaves before the next arrives, which the turn label cannot afford
    // but this can: each resting state keeps a stable slot, so the gap moves nothing.
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={state}
        className={mark ? 'grid size-4 place-items-center leading-none' : 'inline-block'}
        role={mark ? 'img' : undefined}
        aria-label={state === 'running' ? 'Working' : state === 'unread' ? 'Done' : undefined}
        title={state === 'running' ? 'Working' : state === 'unread' ? 'Done' : undefined}
        initial={reduce ? false : TEXT_SWAP_BELOW}
        animate={TEXT_SWAP_REST}
        exit={reduce ? { opacity: 0 } : TEXT_SWAP_ABOVE}
        transition={reduce ? INSTANT : TEXT_SWAP}
      >
        {face}
      </motion.span>
    </AnimatePresence>
  )
}
