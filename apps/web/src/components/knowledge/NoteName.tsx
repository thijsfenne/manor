import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useEffect, useRef, useState } from 'react'
import { fileTitle } from '../../vaultNotes'
import { IconButton } from '../ui/IconButton'

interface NoteNameProps {
  path: string
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (name: string) => void
}

/** The filename is separate from the note's Markdown heading and frontmatter. */
export function NoteName({ path, busy, error, onCancel, onSubmit }: NoteNameProps) {
  const [name, setName] = useState(() => fileTitle(path))
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <div className="min-w-0">
      <form className="flex min-w-0 items-center gap-1" onSubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(name) }}>
        <input ref={input} aria-label="Note name" value={name} readOnly={busy} onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); onCancel() } }}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-1 py-0 text-inherit outline-none focus:border-muted" />
        <IconButton icon={Tick02Icon} size={24} label="Apply note name" disabled={busy} onClick={() => onSubmit(name)} />
        <IconButton icon={Cancel01Icon} size={24} label="Cancel rename" disabled={busy} onClick={onCancel} />
      </form>
      <p className="mt-1 mb-0 font-sans text-[12px] font-normal leading-normal text-muted">{busy ? 'Saving and renaming…' : 'Enter to rename, Esc to cancel'}</p>
      {error === null ? null : <p role="alert" className="mt-1 mb-0 font-sans text-[12px] font-normal leading-normal text-danger">{error}</p>}
    </div>
  )
}
