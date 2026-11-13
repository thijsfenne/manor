import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { Icon } from './Icon'

export const iconButtonClass =
  'grid h-5 w-5 flex-none cursor-pointer place-items-center rounded-chip border-0 bg-transparent text-[15px] leading-none text-muted opacity-0 group-hover/project-head:opacity-100 group-focus-within/project-head:opacity-100 group-hover/project-repo:opacity-100 group-focus-within/project-repo:opacity-100 group-hover/chat-row:opacity-100 group-focus-within/chat-row:opacity-100 [@media(hover:none)]:opacity-100'

/**
 * The quiet half of an undoing: invisible until the row is hovered or focused,
 * and it only ever arms the confirm below, never acts on its own. Used for both
 * kinds of undoing a row offers, deleting it and unlinking what it points at.
 */
export function DeleteButton({ label, onArm }: { label: string; onArm: () => void }) {
  return (
    <button
      type="button"
      className={`${iconButtonClass} hover:bg-bg hover:text-danger`}
      title={label}
      aria-label={label}
      onClick={onArm}
    >
      <Icon icon={Cancel01Icon} size={12} />
    </button>
  )
}

interface ConfirmStripProps {
  /** Spells out what disappears, because deletes cascade and cannot be undone. */
  question: string
  /**
   * Names the act rather than the button, so unlinking a folder never offers a
   * button labelled Delete next to a real path on the user's disk.
   */
  confirmLabel?: string
  /** Let the question run to several lines: in a dialog footer nothing competes with it. */
  wrap?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Replaces the row it belongs to, so a long chat title never gets squeezed out
 * of the way by the buttons that decide its fate. Escape cancels; focus starts
 * on Cancel so a stray Enter is harmless.
 */
export function ConfirmStrip({ question, confirmLabel = 'Delete', wrap = false, onConfirm, onCancel }: ConfirmStripProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onCancel()
  }

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 pl-2 text-[12px] text-muted"
      role="group"
      aria-label={question}
      onKeyDown={handleKeyDown}
    >
      <span className={`min-w-0 flex-1 ${wrap ? '' : 'truncate'}`}>{question}</span>
      <button
        type="button"
        className="flex-none cursor-pointer rounded-button-sm border border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-transparent px-[7px] py-px text-meta text-danger [font:inherit]"
        onClick={onConfirm}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="flex-none cursor-pointer rounded-button-sm border border-line bg-transparent px-[7px] py-px text-meta text-muted hover:text-text [font:inherit]"
        ref={cancelRef}
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  )
}
