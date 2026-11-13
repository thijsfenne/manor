import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search01Icon } from '@hugeicons/core-free-icons'
import { splitPath, type DiffViewFile } from '../../diffView'
import { FileMark } from '../fileMark'
import { Icon } from '../Icon'
import { Popover } from '../ui/Popover'
import { useDismiss } from '../ui/useDismiss'
import { usePopupPlacement } from '../ui/usePopupPlacement'

/**
 * Jump to file: a searchable list of every file in the diff, opened from the bar's
 * search button. The list starts on the file in view, so the arrows walk from where
 * the reader is.
 */
export function DiffFileJump({ files, current, onJump }: { files: readonly DiffViewFile[]; current: string | null; onJump: (key: string) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const close = (refocus = true) => {
    setOpen(false)
    setQuery('')
    if (refocus) trigger.current?.focus()
  }
  const placement = usePopupPlacement({ open, triggerRef: trigger, maxHeight: 380, minHeight: 160, minWidth: 320, align: 'end' })
  useDismiss(open, () => close(false), { within: [trigger, popup], onEscape: close, layoutMoved: true })
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return words.length === 0 ? files : files.filter((file) => words.every((word) => file.path.toLowerCase().includes(word)))
  }, [files, query])
  // The keyboard's row stays in view as the arrows walk past the list's edge.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])
  const pick = (key: string) => {
    close()
    onJump(key)
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Jump to file"
        title="Jump to file"
        disabled={files.length === 0}
        onClick={() => {
          // Opening starts the keyboard on the file in view.
          if (!open) setActive(Math.max(0, files.findIndex((file) => file.key === current)))
          setOpen((value) => !value)
        }}
        className={`grid h-6 w-6 flex-none cursor-pointer place-items-center rounded-full border-0 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${
          open ? 'bg-surface-2 text-text' : 'bg-transparent text-muted hover:bg-surface-2 hover:text-text'}`}
      >
        <Icon icon={Search01Icon} size={14} />
      </button>
      {typeof document === 'undefined' ? null : createPortal(
        <Popover open={open && placement !== null} ref={popup} origin="top-right"
          onReady={() => input.current?.focus()}
          className="fixed z-40 flex flex-col overflow-hidden rounded-xl border border-line surface-floating shadow-menu"
          contentClassName="flex min-h-0 flex-1 flex-col"
          style={placement ?? undefined}>
          <label className="flex flex-none items-center gap-2 border-b border-line px-3 py-2">
            <Icon icon={Search01Icon} size={14} className="flex-none text-dim" />
            <input
              ref={input}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={matches[active] === undefined ? undefined : `${listId}-${active}`}
              aria-label="Find a file in this diff"
              placeholder="Find a file"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  if (matches.length === 0) return
                  setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  const match = matches[active]
                  if (match !== undefined) pick(match.key)
                }
              }}
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-label text-text outline-none placeholder:text-dim"
            />
          </label>
          <div id={listId} role="listbox" aria-label="Files in this diff" className="min-h-0 flex-1 overflow-y-auto p-1">
            {matches.length === 0 ? <p className="m-0 px-2 py-3 text-label text-dim">No file matches.</p> : matches.map((file, index) => {
              const { name, folder } = splitPath(file.path)
              return (
                <div
                  key={file.key}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  onPointerMove={() => setActive(index)}
                  onClick={() => pick(file.key)}
                  className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-label ${index === active ? 'bg-user-bg' : ''}`}
                >
                  <FileMark path={file.path} size={13} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-text">{name}</span>
                    {folder === '' ? null : <span className="text-dim"> {folder}</span>}
                  </span>
                  <span className="flex flex-none items-center gap-1.5 text-meta tabular-nums">
                    {file.added === 0 ? null : <span className="text-ok">+{file.added}</span>}
                    {file.removed === 0 ? null : <span className="text-danger">−{file.removed}</span>}
                  </span>
                </div>
              )
            })}
          </div>
        </Popover>,
        document.body,
      )}
    </>
  )
}
