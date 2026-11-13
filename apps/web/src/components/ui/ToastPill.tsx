import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Alert02Icon, Cancel01Icon, CheckmarkCircle02Icon, LoaderCircleIcon } from '@hugeicons/core-free-icons'
import { TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../../motion'
import { Icon } from '../Icon'
import { IconSwap } from './IconSwap'

/**
 * The window's top-centre pill: a spinner while something runs, a check once it is
 * done, a warning when it `failed`. Provider updates and a Session's Commit or Push
 * report through it. A long label is cut with an ellipsis and kept whole in the tooltip.
 */
export function ToastPill({ done, failed = false, label, dismissLabel, onDismiss }: {
  done: boolean
  failed?: boolean
  label: string
  dismissLabel: string
  onDismiss: () => void
}) {
  const reduce = useReducedMotion() ?? false
  return (
    <div role="status" className="flex max-w-[min(560px,calc(100vw-32px))] items-center gap-2.5 rounded-full border border-line bg-raised py-1.5 pr-1.5 pl-3.5 text-text shadow-pill">
      <IconSwap swapKey={failed ? 'failed' : done ? 'done' : 'running'} className="size-4 flex-none">
        {failed ? (
          <Icon icon={Alert02Icon} size={16} className="text-danger" />
        ) : done ? (
          <Icon icon={CheckmarkCircle02Icon} size={16} className="text-ok" />
        ) : (
          <Icon icon={LoaderCircleIcon} size={16} className="text-muted motion-safe:animate-spin-calm" />
        )}
      </IconSwap>
      <span className="grid min-w-0" title={label}>
        <AnimatePresence initial={false}>
          <motion.span
            key={label}
            className="col-start-1 row-start-1 truncate"
            initial={reduce ? { opacity: 0 } : TEXT_SWAP_BELOW}
            animate={TEXT_SWAP_REST}
            exit={reduce ? { opacity: 0 } : TEXT_SWAP_ABOVE}
            transition={TEXT_SWAP}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </span>
      <ToastDismiss label={dismissLabel} onDismiss={onDismiss} />
    </div>
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
