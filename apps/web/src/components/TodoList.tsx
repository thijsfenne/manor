import { AlertCircleIcon, ArrowDown01Icon, DashedLineCircleIcon, LoaderCircleIcon, MinusSignCircleIcon, PauseCircleIcon } from '@hugeicons/core-free-icons'
import { CheckmarkCircle02Icon as CheckmarkCircleSolidIcon } from '@manor/client-runtime/solid-icons'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useId, useSyncExternalStore } from 'react'
import { isTaskFolded, planRowKeys, planStanding, planTitle, subscribeTaskFolds, toggleTaskFolded, type PlanStanding, type TaskLine } from '../state'
import { DISCLOSURE, INSTANT, PLAN_FILL } from '../motion'
import { Icon } from './Icon'

const MARK = {
  // Solid, so drawn without a stroke: one would trace the check's cut-out shut.
  completed: { icon: CheckmarkCircleSolidIcon, tone: 'text-muted', text: 'text-muted', said: 'Done. ', stroke: 0 },
  in_progress: { icon: LoaderCircleIcon, tone: 'text-text motion-safe:animate-spin-calm', text: 'text-text', said: 'In progress. ' },
  // The step in progress while its turn compacts: still the current step, but still.
  paused: { icon: PauseCircleIcon, tone: 'text-muted', text: 'text-text', said: 'Paused. ' },
  pending: { icon: DashedLineCircleIcon, tone: 'text-muted', text: 'text-text', said: 'To do. ' },
  blocked: { icon: AlertCircleIcon, tone: 'text-danger', text: 'text-text', said: 'Blocked. ' },
  // A plan step its turn ended without ticking: over, so muted, but never a check.
  skipped: { icon: MinusSignCircleIcon, tone: 'text-muted', text: 'text-muted', said: 'Skipped. ' },
} as const

/** What the header's mark says to a screen reader. */
const HEADER_SAID = { working: 'In progress', paused: 'Paused', blocked: 'Blocked', stopped: 'Stopped', done: 'Done' } as const satisfies Record<PlanStanding['mark'], string>

/**
 * The header's mark: a ring that fills as steps finish (1/4, 2/4, ...). It never spins;
 * the current step already does. A finished plan swaps it for the same round check its
 * steps wear, and blocked keeps its alert, since a fraction cannot say a step is stuck.
 */
function PlanRing({ done, total, muted }: { done: number; total: number; muted: boolean }) {
  const reduce = useReducedMotion() ?? false
  const fraction = total === 0 ? 0 : done / total
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      strokeWidth={3}
      data-plan-ring={`${done}/${total}`}
      className={`-rotate-90 ${muted ? 'text-muted' : 'text-text'}`}
    >
      <circle cx={12} cy={12} r={9.5} className="stroke-dim/40" />
      <motion.circle
        cx={12}
        cy={12}
        r={9.5}
        stroke="currentColor"
        strokeLinecap="round"
        initial={false}
        animate={{ pathLength: fraction, opacity: fraction > 0 ? 1 : 0 }}
        transition={reduce ? INSTANT : PLAN_FILL}
      />
    </svg>
  )
}

/**
 * A tasks card: the latest plan a turn published, or the steps Confirm asked for. A
 * snapshot, not a log: a later update replaces what is here, and no lines draw nothing.
 * Its header names the whole task (`title` when the caller knows it, as Confirm does,
 * else read off the plan's own steps), wears one mark for the list and counts the finished lines; the chevron folds
 * the steps away. A revised plan folds its new steps in and its dropped ones out.
 */
export function TodoList({ todos, label, title, foldKey }: { todos: readonly TaskLine[]; label?: string; title?: string; foldKey?: string }) {
  const instance = useId()
  const key = foldKey ?? instance
  const folded = () => isTaskFolded(key)
  const collapsed = useSyncExternalStore(subscribeTaskFolds, folded, folded)
  const reduce = useReducedMotion() ?? false
  if (todos.length === 0) return null
  const standing = planStanding(todos)
  const keys = planRowKeys(todos)
  const heading = title ?? planTitle(todos)
  const transition = reduce ? INSTANT : DISCLOSURE
  return (
    <section aria-label={label ?? 'Tasks'} className="rounded-xl border border-line bg-composer-tray px-3.5 py-3">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${HEADER_SAID[standing.mark]}. ${heading}. ${standing.done} of ${standing.total} done`}
        onClick={() => toggleTaskFolded(key)}
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-[14px] text-text [font-family:inherit]"
      >
        <span className="flex h-[1lh] flex-none items-center" aria-hidden>
          {standing.mark === 'blocked'
            ? <Icon icon={AlertCircleIcon} size={15} className="text-danger" />
            : standing.mark === 'done'
              ? <Icon icon={CheckmarkCircleSolidIcon} size={15} strokeWidth={0} className="text-text" data-plan-done="" />
              : <PlanRing done={standing.done} total={standing.total} muted={standing.mark === 'stopped'} />}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{heading}</span>
        <span className="flex-none text-[12px] text-muted tabular-nums">
          {standing.done}/{standing.total}
        </span>
        <motion.span
          aria-hidden
          className="grid flex-none place-items-center text-muted"
          initial={false}
          animate={{ rotate: collapsed ? -90 : 0 }}
          transition={transition}
        >
          <Icon icon={ArrowDown01Icon} size={14} />
        </motion.span>
      </button>
      {/* Visibility goes with the height, so folded steps leave the tab order and the reader. */}
      <motion.div
        className="overflow-hidden"
        initial={false}
        animate={collapsed ? { height: 0, opacity: 0, visibility: 'hidden' } : { height: 'auto', opacity: 1, visibility: 'visible' }}
        transition={transition}
      >
        {/* Rows pad below instead of a gap, so a row folding in or out carries its own spacing. */}
        <ul className="m-0 -mb-1.5 list-none p-0 pt-2.5">
          <AnimatePresence initial={false}>
            {todos.map((item, index) => {
              const row = MARK[item.status]
              return (
                <motion.li
                  key={keys[index]}
                  className={`overflow-hidden text-[12px] ${row.text}`}
                  initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={transition}
                >
                  <div className="flex items-start gap-2 pb-1.5">
                    <span className="flex h-[1lh] flex-none items-center" aria-hidden>
                      <Icon icon={row.icon} size={15} className={row.tone} {...('stroke' in row ? { strokeWidth: row.stroke } : {})} />
                    </span>
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="sr-only">{row.said}</span>
                      {item.text}
                    </span>
                  </div>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      </motion.div>
    </section>
  )
}
