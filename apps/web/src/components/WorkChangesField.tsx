import { useState, useSyncExternalStore } from 'react'
import { WORK_CHANGES_LIMIT, readWorkChanges, subscribeWorkChanges, writeWorkChanges } from '@manor/client-runtime/work-changes'
import { ComposerEditor } from './ComposerEditor'
import { Button } from './ui/Button'

const NO_AGENTS: never[] = []
const ignorePaste = () => undefined

/**
 * The Request changes field on a result's card and in the Diff panel: the composer's
 * editor, so lists and paragraphs reach the Session as the same Markdown a message
 * does, over the result's draft, so the text outlives leaving the screen. Enter starts
 * a new line, ⌘Enter sends, Escape closes.
 */
export function WorkChangesField({ handoffId, pending, connected, autoFocus, onCancel, onSend }: {
  handoffId: string
  pending: boolean
  connected: boolean
  /** Put the caret at the end on mount; false where the field was already open before. */
  autoFocus: boolean
  onCancel: () => void
  onSend: (text: string) => void
}) {
  const read = () => readWorkChanges(handoffId)
  const text = useSyncExternalStore(subscribeWorkChanges, read, read)
  const [caret, setCaret] = useState(text.length)
  const editable = !pending && connected
  const over = text.trim().length - WORK_CHANGES_LIMIT
  const canSend = editable && text.trim() !== '' && over <= 0
  const send = () => {
    if (canSend) onSend(text.trim())
  }
  return (
    <div className="flex flex-col gap-2">
      <div
        data-work-changes
        aria-disabled={!editable}
        className="rounded-lg border border-line bg-field px-1 py-0.5 focus-within:border-field-focus aria-disabled:opacity-60 [&_[data-composer-editor]]:min-h-[4.5rem]"
      >
        <ComposerEditor
          value={text}
          caret={Math.min(caret, text.length)}
          agents={NO_AGENTS}
          skills={NO_AGENTS}
          allowBrowser={false}
          allowComputer={false}
          allowWork={false}
          placeholder="What should change?"
          autoFocus={autoFocus}
          dense
          ariaLabel="Requested changes"
          editable={editable}
          onChange={(value, nextCaret) => {
            setCaret(nextCaret)
            writeWorkChanges(handoffId, value)
          }}
          onCommand={(key, event) => {
            if (key === 'Escape') {
              onCancel()
              return true
            }
            if (key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              send()
              return true
            }
            return false
          }}
          onPaste={ignorePaste}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        {over > 0 ? (
          <p role="alert" className="m-0 mr-auto text-[13px] text-danger">
            {over.toLocaleString('en-US')} {over === 1 ? 'character' : 'characters'} over the {WORK_CHANGES_LIMIT.toLocaleString('en-US')} limit
          </p>
        ) : null}
        <Button size="compact" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
        <Button size="compact" variant="primary" disabled={!canSend} onClick={send}>
          {pending ? 'Sending…' : 'Send to Session'}
        </Button>
      </div>
    </div>
  )
}
