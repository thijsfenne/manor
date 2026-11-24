import { useState } from 'react'
import { DiscardModal } from './DiscardModal'
import { Modal, ModalFooter } from './Modal'
import { Button } from './ui/Button'
import { formInputClass } from './ui/FormField'

/**
 * The task a session proposal will start from, read in full and edited before Accept.
 * Save hands the edit back to the card; nothing reaches the server until Accept.
 * Escape, the close button and the backdrop ask before they drop a changed prompt;
 * the Cancel button is the explicit no and does not.
 */
export function WorkPromptDialog({
  title,
  task,
  onSave,
  onClose,
}: {
  title: string
  task: string
  onSave: (task: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(task)
  const trimmed = draft.trim()
  const [asking, setAsking] = useState(false)
  const leave = () => (draft === task ? onClose() : setAsking(true))
  return (
    <>
    <Modal title="Prompt" subtitle={title} width="wide" onClose={leave}>
      <textarea
        aria-label="Prompt"
        className={`${formInputClass} min-h-[320px] resize-y leading-relaxed`}
        maxLength={40_000}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <ModalFooter>
        <div className="flex items-center justify-end gap-2 pt-0.5">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={trimmed.length === 0}
            onClick={() => {
              onSave(trimmed)
              onClose()
            }}
          >
            Save
          </Button>
        </div>
      </ModalFooter>
    </Modal>
    {!asking ? null : (
      <DiscardModal onKeep={() => setAsking(false)} onDiscard={onClose}>This prompt has edits that are not saved yet. Leaving drops them.</DiscardModal>
    )}
    </>
  )
}
