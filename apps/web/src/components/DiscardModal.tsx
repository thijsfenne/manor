import { Modal } from './Modal'
import { Button } from './ui/Button'

/**
 * The question before unsaved text is dropped; `children` says in one line what would go.
 * Render it as a sibling of the dialog it guards, not a child, so its Escape never
 * reaches that dialog's own.
 */
export function DiscardModal({ children, onKeep, onDiscard }: { children: string; onKeep: () => void; onDiscard: () => void }) {
  return (
    <Modal title="Discard unsaved changes?" onClose={onKeep}>
      <p className="m-0 text-[14px] text-muted">{children}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onKeep}>Keep editing</Button>
        <Button variant="danger" onClick={onDiscard}>Discard</Button>
      </div>
    </Modal>
  )
}
