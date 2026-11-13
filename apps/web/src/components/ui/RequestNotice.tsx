import { Cancel01Icon } from '@hugeicons/core-free-icons'
import type { Notice } from '../../state'
import { Icon } from '../Icon'

interface RequestNoticeProps {
  notice: Notice
  onDismiss?: () => void
  className?: string
}

/** The server's answer, kept next to the control that asked the question. */
export function RequestNotice({ notice, onDismiss, className = '' }: RequestNoticeProps) {
  return (
    <p
      className={`m-0 flex items-baseline gap-1.5 px-0.5 pt-1 text-label ${
        notice.kind === 'error' ? 'text-danger' : 'text-muted'
      } ${className}`}
      role="status"
    >
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{notice.text}</span>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="grid flex-none cursor-pointer place-items-center self-center border-0 bg-transparent px-0.5 py-0 text-inherit [font:inherit]"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <Icon icon={Cancel01Icon} size={11} />
        </button>
      )}
    </p>
  )
}
