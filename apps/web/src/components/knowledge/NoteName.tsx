import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from '../ui/IconButton'

interface NoteNameProps {
  path: string
  editing: boolean
  busy: boolean
  disabled: boolean
  error: string | null
  onStart: () => void
  onCancel: () => void
  onSubmit: (name: string) => void
}

/** The filename is separate from the note's Markdown heading and frontmatter. */
export function NoteName({ path, editing, busy, disabled, error, onStart, onCancel, onSubmit }: NoteNameProps) {
  const title = path.split('/').at(-1)?.replace(/\.md$/i, '') ?? path
  const [name, setName] = useState(title)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) return
    setName(title)
    input.current?.focus()
    input.current?.select()
  }, [editing, title])

  if (!editing) return (
    <button type="button" disabled={disabled} onClick={onStart} aria-label={`Rename ${title}`} title="Click to rename"
      className="-ml-1 block max-w-full cursor-text truncate rounded-md border-0 bg-transparent px-1 py-0 text-left text-inherit hover:bg-tree-hover disabled:cursor-default">
      {title}
    </button>
  )

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
