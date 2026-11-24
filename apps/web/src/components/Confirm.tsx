import { useEffect, useRef } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { Button } from './ui/Button'

export const iconButtonClass =
  'grid h-5 w-5 flex-none cursor-pointer place-items-center rounded-chip border-0 bg-transparent text-[15px] leading-none text-muted opacity-0 group-hover/project-head:opacity-100 group-focus-within/project-head:opacity-100 group-hover/project-repo:opacity-100 group-focus-within/project-repo:opacity-100 group-hover/chat-row:opacity-100 group-focus-within/chat-row:opacity-100 [@media(hover:none)]:opacity-100'

/**
 * The quiet half of an undoing: invisible until the row is hovered or focused,
 * and it only ever arms a confirm, never acts on its own. Used for both
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

interface ConfirmModalProps {
  /** The question itself, short: "Delete this chat?". */
  title: string
  /** What else goes or stays, in a sentence. Left out when the title says it all. */
  children?: string
  /**
   * Names the act rather than the button, so unlinking a folder never offers a
   * button labelled Delete next to a real path on the user's disk.
   */
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  /** Escape, the backdrop, the close mark and the cancel button all land here. */
  onCancel: () => void
}

/**
 * The question before something is undone for good. Focus starts on Cancel, so a
 * stray Enter is harmless.
 *
 * Inside another dialog, render it as a sibling of that dialog, not a child: a
 * portal still bubbles through the React tree, so the outer card would also see its
 * Escape and its Tab. Beside a row that reacts to clicks or drags, render it next to
 * the row for the same reason.
 */
export function ConfirmModal({ title, children, confirmLabel = 'Delete', cancelLabel = 'Cancel', onConfirm, onCancel }: ConfirmModalProps) {
  const actions = useRef<HTMLDivElement>(null)
  // An effect rather than autoFocus: a dialog mounting in the same commit (a form opened
  // straight on its delete) runs its own focus effect after autoFocus and would take it.
  // Cancel is the first of the two buttons.
  useEffect(() => {
    actions.current?.querySelector('button')?.focus()
  }, [])

  return (
    <Modal title={title} onClose={onCancel}>
      {children === undefined ? null : <p className="m-0 text-[14px] text-muted">{children}</p>}
      <div ref={actions} className="flex justify-end gap-2">
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button variant="danger" onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Modal>
  )
}

/** Deleting a chat from a list: the question every list of chats asks the same way. */
export function DeleteChatConfirm({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmModal title={`Delete “${title}”?`} onConfirm={onConfirm} onCancel={onCancel}>
      All its messages go with it.
    </ConfirmModal>
  )
}
