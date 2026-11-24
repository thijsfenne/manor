import { ConfirmModal } from './Confirm'

/**
 * The question before unsaved text is dropped; `children` says in one line what would go.
 * Render it as a sibling of the dialog it guards, not a child, so its Escape never
 * reaches that dialog's own.
 */
export function DiscardModal({ children, onKeep, onDiscard }: { children: string; onKeep: () => void; onDiscard: () => void }) {
  return (
    <ConfirmModal title="Discard unsaved changes?" confirmLabel="Discard" cancelLabel="Keep editing" onConfirm={onDiscard} onCancel={onKeep}>
      {children}
    </ConfirmModal>
  )
}
