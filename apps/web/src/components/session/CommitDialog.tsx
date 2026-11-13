import { useState } from 'react'
import type { SessionRepo } from '@manor/contracts'
import { splitPath } from '../../diffView'
import { FileMark } from '../fileMark'
import { Modal } from '../Modal'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { formInputClass } from '../ui/FormField'

interface CommitDialogProps {
  repo: SessionRepo
  /** A failed Commit's ticked files and message, so it reopens as it was left. */
  initial?: { files: readonly string[]; message: string }
  pending: boolean
  /** What the server said when it refused, shown above the buttons. */
  error: string | null
  connected: boolean
  onClose: () => void
  onCommit: (files: string[], message: string) => void
}

/**
 * Commit for a Session nobody set a goal for. Only this Session's uncommitted files are
 * listed, all ticked; an unticked one stays as it is, and nothing outside the list is
 * ever taken. An empty message asks Manor to write one from the diff. The dialog
 * closes once Manor takes the commit on; the checks run after, in the background.
 */
export function CommitDialog({ repo, initial, pending, error, connected, onClose, onCommit }: CommitDialogProps) {
  const [message, setMessage] = useState(initial?.message ?? '')
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set(initial === undefined ? []
    : repo.uncommitted.flatMap((file) => initial.files.includes(file.path) ? [] : [file.path])))
  const files = repo.uncommitted
  const ticked = files.filter((file) => !skipped.has(file.path))
  const all = ticked.length === files.length
  const submit = () => {
    if (ticked.length === 0 || pending || !connected) return
    onCommit(ticked.map((file) => file.path), message.trim())
  }
  const toggle = (path: string, on: boolean) => setSkipped((current) => {
    const next = new Set(current)
    if (on) next.delete(path)
    else next.add(path)
    return next
  })

  return (
    <Modal title="Commit" subtitle={`${repo.label} · ${repo.branch ?? 'not on a branch'}`} onClose={onClose}>
      <label className="flex flex-col gap-1.5">
        <span className="text-label text-muted">Message</span>
        <textarea
          autoFocus
          rows={3}
          maxLength={5_000}
          value={message}
          disabled={pending}
          placeholder="Leave empty and Manor writes one from the diff"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submit()
            }
          }}
          className={`${formInputClass} resize-y leading-relaxed`}
        />
      </label>

      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-1.5 flex w-full items-center p-0 text-label text-muted">
          <span>{ticked.length} of {files.length} {files.length === 1 ? 'file' : 'files'}</span>
          <button type="button" className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-label text-muted hover:text-text"
            disabled={pending} onClick={() => setSkipped(all ? new Set(files.map((file) => file.path)) : new Set())}>
            {all ? 'Untick all' : 'Tick all'}
          </button>
        </legend>
        <ul className="m-0 flex max-h-[280px] list-none flex-col overflow-y-auto rounded-lg border border-line p-1">
          {files.map((file) => {
            const { name, folder } = splitPath(file.path)
            return (
              <li key={file.path}>
                <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2">
                  <Checkbox checked={!skipped.has(file.path)} disabled={pending} onChange={(on) => toggle(file.path, on)} />
                  <FileMark path={file.path} size={14} />
                  <span className="min-w-0 flex-1 truncate" title={file.path}>
                    <span className="text-text">{name}</span>
                    {folder === '' ? null : <span className="text-dim"> {folder}</span>}
                  </span>
                  {file.status === 'edited' ? null : <span className="flex-none text-meta text-dim">{file.status === 'created' ? 'new' : 'deleted'}</span>}
                  <span className="flex flex-none items-center gap-1.5 text-meta tabular-nums">
                    {file.added === 0 ? null : <span className="text-ok">+{file.added}</span>}
                    {file.removed === 0 ? null : <span className="text-danger">−{file.removed}</span>}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      </fieldset>

      {error === null ? null : <p role="alert" className="m-0 text-[13px] text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button size="small" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="small" variant="primary" disabled={ticked.length === 0 || pending || !connected} onClick={submit}>
          {pending ? 'Committing…' : ticked.length === files.length ? 'Commit' : `Commit ${ticked.length} ${ticked.length === 1 ? 'file' : 'files'}`}
        </Button>
      </div>
    </Modal>
  )
}
