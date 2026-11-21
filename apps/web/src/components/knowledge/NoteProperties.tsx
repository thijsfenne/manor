import {
  Add01Icon,
  Calendar03Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  File01Icon,
  Link01Icon,
  Tag01Icon,
  TextIcon,
} from '@hugeicons/core-free-icons'
import { useState, type KeyboardEvent } from 'react'
import { Icon } from '../Icon'
import { IconButton } from '../ui/IconButton'
import { propertyText, type PropertyRow } from './frontmatterEdits'

const propertyIcons = new Map([
  ['date', Calendar03Icon],
  ['status', CheckmarkCircle02Icon],
  ['tags', Tag01Icon],
  ['type', File01Icon],
  ['source', Link01Icon],
])

const statusColors = new Map([
  ['active', 'bg-busy/12 text-busy'],
  ['done', 'bg-ok/12 text-ok'],
  ['completed', 'bg-ok/12 text-ok'],
  ['blocked', 'bg-warn/12 text-warn'],
  ['pending', 'bg-warn/12 text-warn'],
  ['failed', 'bg-danger/12 text-danger'],
])

const field = 'min-h-7 w-full min-w-0 rounded-md border-0 bg-surface-2 px-1.5 py-0.5 text-label text-text outline-none placeholder:text-dim'

export interface NotePropertiesProps {
  rows: readonly PropertyRow[]
  /** False while the note cannot be edited; the list then only reads. */
  editable: boolean
  onSet: (row: PropertyRow, value: string) => void
  /** Adds a property; returns why it was refused, or null. */
  onAdd: (key: string, value: string) => string | null
  onRemove: (row: PropertyRow) => void
}

/**
 * The note's frontmatter as the only place to edit it: a value turns into a field on
 * a click, a row's cross removes it, and Add property appends one. The YAML itself is
 * never shown; `frontmatterEdits.ts` writes each change back into the file's own lines.
 */
export function NoteProperties({ rows, editable, onSet, onAdd, onRemove }: NotePropertiesProps) {
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <div className="mx-auto mb-3 max-w-[46rem] border-b border-line pb-4">
      {rows.length === 0 ? null : (
        <dl aria-label="Properties" className="m-0 grid grid-cols-[minmax(0,min(32%,7.5rem))_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 text-label">
          {rows.map((row) => (
            <div key={`${row.line}:${row.key}`} className="group contents">
              <dt className="flex min-h-7 min-w-0 items-center gap-2 text-muted" title={row.key}>
                <Icon icon={propertyIcons.get(row.key) ?? TextIcon} size={14} aria-hidden className="flex-none" />
                <span className="truncate first-letter:uppercase">{row.key}</span>
              </dt>
              <dd className="m-0 flex min-w-0 items-start gap-1">
                {editing === row.line && editable && row.editable ? (
                  <ValueField
                    label={`${row.key} value`}
                    initial={propertyText(row)}
                    onDone={(value) => {
                      setEditing(null)
                      if (value !== null) onSet(row, value)
                    }}
                  />
                ) : (
                  <button type="button" aria-label={`Edit ${row.key}: ${row.values.join(', ') || 'empty'}`}
                    disabled={!editable || !row.editable}
                    title={row.editable ? undefined : 'This value is written in a form the property list cannot edit.'}
                    className="flex min-h-7 w-full min-w-0 cursor-text flex-wrap items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-label text-text enabled:hover:bg-tree-hover focus-visible:bg-tree-hover disabled:cursor-default"
                    onClick={() => setEditing(row.line)}>
                    <Values row={row} />
                  </button>
                )}
                {editable ? (
                  <IconButton icon={Cancel01Icon} size={28} iconSize={13} label={`Remove ${row.key}`}
                    className="flex-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => onRemove(row)} />
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!editable ? null : adding ? (
        <NewProperty onDone={(key, value) => {
          if (key === null) { setAdding(false); return null }
          const error = onAdd(key, value)
          if (error === null) setAdding(false)
          return error
        }} />
      ) : (
        <button type="button" className={`flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-label text-muted hover:text-text ${rows.length === 0 ? '' : 'mt-1'}`}
          onClick={() => setAdding(true)}>
          <Icon icon={Add01Icon} size={14} aria-hidden />
          Add property
        </button>
      )}
    </div>
  )
}

function Values({ row }: { row: PropertyRow }) {
  if (row.values.length === 0) return <span className="text-muted italic">empty</span>
  return row.values.map((value, index) => (
    <span key={index} className={row.key === 'status'
      ? `inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-meta wrap-anywhere ${statusColors.get(value.toLowerCase()) ?? 'bg-surface-2 text-muted'}`
      : row.key === 'tags'
        ? 'rounded-chip bg-surface-2 px-1.5 py-0.5 text-meta wrap-anywhere text-muted'
        : 'wrap-anywhere'}>
      {row.key === 'status' ? <span aria-hidden className="size-1.5 flex-none rounded-full bg-current" /> : null}
      {value}
    </span>
  ))
}

/** Enter or leaving the field keeps the value; Escape drops it. Null means dropped. */
function ValueField({ label, initial, onDone }: { label: string; initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const [closed, setClosed] = useState(false)
  const close = (result: string | null) => {
    if (closed) return
    setClosed(true)
    onDone(result)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); close(value) }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(null) }
  }
  return (
    // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is what the click asked for
    <input autoFocus aria-label={label} value={value} spellCheck={false} className={field}
      onChange={(event) => setValue(event.target.value)} onKeyDown={onKeyDown} onBlur={() => close(value)} />
  )
}

function NewProperty({ onDone }: { onDone: (key: string | null, value: string) => string | null }) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    if (key.trim() === '') { onDone(null, ''); return }
    setError(onDone(key.trim(), value))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); submit() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(null, '') }
  }
  return (
    <div className="mt-1">
      <div role="group" aria-label="New property" className="grid grid-cols-[minmax(0,min(32%,7.5rem))_minmax(0,1fr)] gap-x-2">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the field is what the click asked for */}
        <input autoFocus aria-label="Property name" placeholder="Name" value={key} spellCheck={false} className={field}
          onChange={(event) => { setKey(event.target.value); setError(null) }} onKeyDown={onKeyDown} />
        <input aria-label="Property value" placeholder="Value" value={value} spellCheck={false} className={field}
          onChange={(event) => setValue(event.target.value)} onKeyDown={onKeyDown} />
      </div>
      {error === null ? null : <p role="alert" className="mt-1 mb-0 text-meta text-danger">{error}</p>}
    </div>
  )
}
