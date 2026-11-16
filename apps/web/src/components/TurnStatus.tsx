import { ChevronDownIcon } from '@hugeicons/core-free-icons'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { TurnRow } from '../state'
import { elapsedLabel, workedLabel } from '../turnLabels'
import { backgroundStillRunning, hasFold, hasStatus, isCompacting, isPaused, turnSummary } from '../turnTrace'
import { INSTANT, TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../motion'
import { Icon } from './Icon'
import { useNowSecond } from '../useNowSecond'

/**
 * Chrome that shows only while the turn is hovered or holds focus, and always on a
 * screen without hover. It answers to the `group/turn` element around the turn. Only
 * the ink goes: where the chrome sits, and whether it holds room, is its caller's call.
 */
export const QUIET_CHROME = 'opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 [@media(hover:none)]:opacity-100'

interface TurnStatusProps {
  turn: TurnRow
  /** Whether the whole activity stream under this row is visible. */
  open: boolean
  onToggle: () => void
  /** Removes the name-side inset when the status is the whole row, as in side chat. */
  standalone?: boolean
  /** A more specific live state supplied by structured transcript events. */
  runningLabel?: string
  /**
   * A DM, where this line only ever describes a finished turn (its working indicator
   * sits at the foot of the chat). A stopped or broken turn says how long it worked,
   * never Stopped: the user carries on by typing.
   */
  dm?: boolean
  /** A project thread, which keeps every grey line of a finished turn out of the feed. */
  thread?: boolean
}

/**
 * What a turn is doing, on the same line as the name of whoever is doing it.
 *
 * This stable status owns the outer turn fold; each uninterrupted run below keeps its
 * own inner accordion. The two levels answer different questions: whether to see the
 * work at all, and which evidence inside that work to inspect.
 *
 * It carries no animation of its own. The persona's face already thinks in dots
 * a few pixels to the left. The words still swap in place when they change,
 * and stop the instant the turn does.
 *
 * Once the turn is over the line is its record, and waits for hover or focus on the
 * turn; it stays while its trace is open, as the way back. The model is named only in the
 * tooltip of a finished turn.
 */
export function TurnStatus({ turn, open, onToggle, standalone = false, runningLabel, dm = false, thread = false }: TurnStatusProps) {
  const running = turn.live?.state === 'running'
  // An open trace shows Compacting in its own row, so the status keeps Working then.
  const compacting = !open && isCompacting(turn)
  const now = useNowSecond(running)
  const reduce = useReducedMotion() ?? false
  const foldable = hasFold(turn)
  const broken = dm && !running && (turn.note?.kind === 'aborted' || turn.note?.kind === 'error')
  const worked = workedLabel(turn.startedAt, turn.endedAt)
  const summary = broken
    ? worked === undefined ? '' : `Worked for ${worked}`
    : running && runningLabel !== undefined && !compacting ? runningLabel : turnSummary(turn, open)
  const shimmers = running && compacting
  // The clock is part of the sentence, "Working for 9s", in the same words and colour.
  // Waiting already names the state, so its clock follows without a connective.
  // Compacting shows no clock until Working returns.
  const elapsed = elapsedLabel(turn.live?.startedAt, now)
  const shown =
    !running || compacting
      ? summary
      : isPaused(turn) ? `${summary} ${elapsed}` : `${summary.replace(/…$/, '')} for ${elapsed}`

  // Stopped and a wait on background work are states a Session's turn still has to
  // say, so there they stay shown. A project thread and a DM rest those too.
  const still = backgroundStillRunning(turn)
  const state = turn.note?.kind === 'aborted' || still.agents + still.commands > 0
  const quiet = !running && !open && (thread || dm || !state)

  // A turn with nothing to say says nothing: an empty status beside a name is a gap
  // the eye still has to cross. What counts as something is `hasStatus`, and it is
  // wider than "has a trace" on purpose — see the note there.
  if (!hasStatus(turn) || (summary === '' && !running && !foldable)) return null

  // Focus mode hides the line. A running turn with no face beside it (a Single
  // chat) keeps it, or a turn still going would look finished.
  return (
    <span
      {...(running && standalone ? {} : { 'data-chrome': '' })}
      // Only the button takes clicks: the empty rest of this full-width row may lie over a relay line.
      className={`pointer-events-none mt-[3px] flex min-w-0 flex-1 items-center text-[13px] leading-none font-normal text-muted${standalone ? '' : ' ml-2'}${quiet ? ` ${QUIET_CHROME}` : ''}`}>
      <button
        type="button"
        className="pointer-events-auto group flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 text-left hover:text-text disabled:cursor-default disabled:hover:text-muted"
        title={!running && turn.reportedModel !== undefined ? `This turn ran on ${turn.reportedModel}` : undefined}
        aria-expanded={foldable ? open : undefined}
        disabled={!foldable}
        onClick={onToggle}
      >
        {/* The line changes while it is being read (working, then how long it took),
            so it swaps in place rather than cutting. It is keyed by the state, not
            the ticking text, so the clock counts without swapping every second.
            `popLayout` takes the leaving words out of flow, which is what keeps the
            chevron beside it from sliding twice per swap. */}
        {summary === '' ? null : (
          <span className="relative min-w-0 truncate leading-tight">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={summary}
                className={shimmers ? 'shimmer-text' : undefined}
                data-text={shimmers ? summary : undefined}
                initial={reduce ? false : TEXT_SWAP_BELOW}
                animate={TEXT_SWAP_REST}
                exit={reduce ? { opacity: 0 } : TEXT_SWAP_ABOVE}
                transition={reduce ? INSTANT : TEXT_SWAP}
              >
                {shown}
              </motion.span>
            </AnimatePresence>
          </span>
        )}
        {foldable ? (
          <span className="flex shrink-0 items-center text-dim transition-colors duration-200 ease-fade group-hover:text-muted">
            <Icon
              icon={ChevronDownIcon}
              size={13}
              className={`duration-200 ease-overshoot motion-safe:transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </span>
        ) : null}
      </button>
    </span>
  )
}
