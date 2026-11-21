import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

export interface NoteTitleProps {
  /** A rename is on its way to the server. */
  busy: boolean
  error: string | null
  onSubmit: (name: string) => void
  onDismissError: () => void
}

/**
 * The note's name as its large title, edited in place. One line: Enter, a paste with
 * line breaks or leaving the field commits it through the panel's rename, and Enter
 * then carries on into the body. A refused name shows why and the old one comes back.
 */
export function NoteTitle({ path, busy, error, onSubmit, onDismissError, focusRequest, onFocusHandled, onEnter }: NoteTitleProps & {
  path: string
  /** Asked from the tree or a tab's menu: focus the title with its text selected. */
  focusRequest: boolean
  onFocusHandled: () => void
  onEnter: () => void
}) {
  const [name, setName] = useState(() => fileTitle(path))
  const [commits, setCommits] = useState(0)
  const field = useRef<HTMLTextAreaElement>(null)
  // Enter and Escape blur the field themselves; the blur that follows must not commit (again).
  const settled = useRef(false)
  const leave = (move: () => void) => {
    settled.current = true
    move()
    settled.current = false
  }

  // The file's own name comes back whenever the field is idle: after a rename lands,
  // after one is refused, and when another note opens in this tab.
  useEffect(() => {
    if (busy || field.current === field.current?.ownerDocument.activeElement) return
    setName(fileTitle(path))
  }, [path, busy, error, commits])

  useEffect(() => {
    if (!focusRequest) return
    field.current?.focus()
    field.current?.select()
    onFocusHandled()
  }, [focusRequest, onFocusHandled])

  // Wraps like the heading it replaces, growing with its text rather than scrolling.
  useLayoutEffect(() => {
    const element = field.current
    if (element === null) return
    element.style.height = '0px'
    element.style.height = `${element.scrollHeight}px`
  })

  const commit = () => {
    setCommits((count) => count + 1)
    const next = name.trim()
    // An empty name goes too, so the panel refuses it with its own message.
    if (next === fileTitle(path)) return
    onSubmit(next)
  }

  return (
    <div className="min-w-0">
      <textarea
        ref={field}
        aria-label="Note title"
        rows={1}
        value={name}
        readOnly={busy}
        spellCheck={false}
        className="m-0 block w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-display text-[clamp(26px,4vw,34px)] leading-[1.15] font-medium tracking-[-0.02em] wrap-anywhere text-text outline-none"
        onChange={(event) => {
          setName(event.target.value.replace(/[\r\n]+/g, ' '))
          if (error !== null) onDismissError()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            commit()
            leave(onEnter)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setName(fileTitle(path))
            leave(() => field.current?.blur())
          }
        }}
        onBlur={() => { if (!settled.current) commit() }}
      />
      {busy ? <p className="mt-1 mb-0 text-meta text-muted">Renaming…</p> : null}
      {error === null ? null : <p role="alert" className="mt-1 mb-0 text-meta text-danger">{error}</p>}
    </div>
  )
}
