import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Alert02Icon, Cancel01Icon, CheckmarkCircle02Icon, LoaderCircleIcon } from '@hugeicons/core-free-icons'
import { TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../../motion'
import { Icon } from '../Icon'
import { IconSwap } from './IconSwap'

/** Every card in the window's notice stack is this wide, so the column reads as one. */
export const NOTICE_WIDTH = 'w-[min(380px,calc(100vw-32px))]'

/**
 * One card in the notice stack: a mark, what happened, the chat it is about, an
 * action and a close button. The mark sits in a box one title line tall, so it centres
 * on the title rather than on the text block.
 */
export function NoticeCard({ mark, title, body, action, alert = false, dismissLabel = 'Dismiss', onDismiss }: {
  mark: ReactNode
  title: string
  body?: string
  action?: ReactNode
  alert?: boolean
  dismissLabel?: string
  onDismiss: () => void
}) {
  const reduce = useReducedMotion() ?? false
  return (
    <div role={alert ? 'alert' : 'status'}
      className={`${NOTICE_WIDTH} flex items-start gap-2.5 rounded-xl border border-line bg-raised py-2 pr-2 pl-3.5 text-text shadow-popover`}>
      <span className="grid h-7 flex-none place-items-center">{mark}</span>
      <div className="grid min-w-0 flex-1 py-1">
        {/* A label that changes in place (a spinner's line turning into its outcome) swaps
            rather than jumps. */}
        <AnimatePresence initial={false}>
          <motion.p
            key={title}
            className="col-start-1 row-start-1 m-0 truncate leading-5"
            title={title}
            initial={reduce ? { opacity: 0 } : TEXT_SWAP_BELOW}
            animate={TEXT_SWAP_REST}
            exit={reduce ? { opacity: 0 } : TEXT_SWAP_ABOVE}
            transition={TEXT_SWAP}
          >
            {title}
          </motion.p>
        </AnimatePresence>
        {body === undefined || body === '' ? null : <p className="m-0 truncate text-label leading-5 text-muted" title={body}>{body}</p>}
      </div>
      {action === undefined ? null : <span className="flex flex-none items-center self-center">{action}</span>}
      <ToastDismiss label={dismissLabel} onDismiss={onDismiss} />
    </div>
  )
}

/** A spinner while something runs, a check once it is done, a warning when it failed; swapped in place. */
export function ProgressMark({ tone }: { tone: 'running' | 'done' | 'failed' }) {
  return (
    <IconSwap swapKey={tone} className="size-4 flex-none">
      {tone === 'failed' ? (
        <Icon icon={Alert02Icon} size={16} className="text-danger" />
      ) : tone === 'done' ? (
        <Icon icon={CheckmarkCircle02Icon} size={16} className="text-ok" />
      ) : (
        <Icon icon={LoaderCircleIcon} size={16} className="text-muted motion-safe:animate-spin-calm" />
      )}
    </IconSwap>
  )
}

export function ToastDismiss({ label, onDismiss, className = '' }: { label: string; onDismiss: () => void; className?: string }) {
  return (
    <button
      type="button"
      className={`${className} grid size-7 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent text-dim hover:bg-surface-2 hover:text-text`}
      title={label}
      aria-label={label}
      onClick={onDismiss}
    >
      <Icon icon={Cancel01Icon} size={14} />
    </button>
  )
}
