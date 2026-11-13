import { Folder01Icon, Search01Icon } from '@hugeicons/core-free-icons'
import { insideVaultEntry } from '@manor/client-runtime/state'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { VaultState } from '../../state'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'

/** Past this many destinations the list gets a filter field on top. */
const FILTER_FROM = 7

interface MoveDialogProps {
  entry: { path: string; kind: 'file' | 'folder' }
  /** Every folder in the vault listing, which is what the destinations are built from. */
  folders: readonly string[]
  /** This client's own move and its answer. */
  move: VaultState['move']
  /** False while the socket is down. */
  canMove: boolean
  /** Sends the move; false when nothing left the browser. */
  onMove: (requestId: string, path: string, folder: string, notify: boolean) => boolean
  onClose: () => void
}

interface Destination {
  /** `''` is the top level. */
  folder: string
  label: string
  depth: number
  /** The folder the entry already sits in. */
  current: boolean
  disabled: boolean
}

export const parentFolder = (path: string) => path.split('/').slice(0, -1).join('/')

/**
 * Where a note or folder can go: the top level first, then every folder as an indented
 * tree. The entry's own folder is marked and cannot be picked, and so is a moved folder
 * itself and everything inside it.
 */
export function moveDestinations(entry: MoveDialogProps['entry'], folders: readonly string[]): Destination[] {
  const from = parentFolder(entry.path)
  const blocked = (folder: string) => entry.kind === 'folder' && insideVaultEntry(folder, entry.path)
  const sorted = [...folders].sort((left, right) => left.localeCompare(right, 'en'))
  return [
    { folder: '', label: 'Top level', depth: 0, current: from === '', disabled: from === '' },
    ...sorted.map((folder) => ({
      folder,
      label: folder.split('/').at(-1) ?? folder,
      depth: folder.split('/').length,
      current: folder === from,
      disabled: folder === from || blocked(folder),
    })),
  ]
}

/** The house dialog for "Move to…": pick a folder, then Move. A refusal stays inside it. */
export function MoveDialog({ entry, folders, move, canMove, onMove, onClose }: MoveDialogProps) {
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const filter = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const all = useMemo(() => moveDestinations(entry, folders), [entry, folders])
  const filtering = all.length > FILTER_FROM
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return all
    // Flat while filtering, by whole path, because a match deep down has no parents shown.
    return all.filter((option) => (option.folder === '' ? option.label : option.folder).toLowerCase().includes(needle)).map((option) => ({ ...option, label: option.folder === '' ? option.label : option.folder, depth: 0 }))
  }, [all, query])
  const last = entry.path.split('/').at(-1) ?? entry.path
  const name = entry.kind === 'file' ? last.replace(/\.md$/i, '') : last
  const title = entry.kind === 'file' ? 'Move note' : 'Move folder'
  const pending = requestId !== null
  const selectable = shown.filter((option) => !option.disabled)
  const valid = chosen !== null && selectable.some((option) => option.folder === chosen)
  const active = valid && chosen !== null ? { 'aria-activedescendant': `${listId}-${all.findIndex((option) => option.folder === chosen)}` } : {}

  // The list takes the keys when there is no filter field to hold them.
  useEffect(() => {
    if (!filtering) list.current?.focus()
  }, [filtering])

  // Where the keys belong. The Move button disables itself while the move is out, and
  // a disabled button drops focus to the page, where Escape and Enter reach nothing.
  const holdKeys = () => {
    const holder = filtering ? filter.current : list.current
    if (holder !== null && holder.ownerDocument.activeElement !== holder) holder.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (requestId === null || move?.requestId !== requestId || move.result === null) return
    if (move.result.status === 'rejected') {
      setRequestId(null)
      setError(move.result.message)
      holdKeys()
      return
    }
    onClose()
  }, [move, requestId, onClose])

  useEffect(() => {
    if (canMove || requestId === null) return
    setRequestId(null)
    setError('Connection lost. Check the tree after reconnecting before trying again.')
  }, [canMove, requestId])

  useEffect(() => {
    if (chosen === null) return
    for (const element of list.current?.querySelectorAll<HTMLElement>('[data-folder]') ?? []) {
      if (element.dataset['folder'] === chosen) element.scrollIntoView?.({ block: 'nearest' })
    }
  }, [chosen])

  const submit = (folder = chosen) => {
    if (folder === null || pending || !selectable.some((option) => option.folder === folder)) return
    if (!canMove) { setError('Reconnect before moving.'); return }
    const id = crypto.randomUUID()
    if (onMove(id, entry.path, folder, false)) { setRequestId(id); setError(null); holdKeys() }
    else setError('Reconnect before moving.')
  }

  const onKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (selectable.length === 0) return
    const at = selectable.findIndex((option) => option.folder === chosen)
    const next = event.key === 'ArrowDown'
      ? (at === -1 ? 0 : Math.min(at + 1, selectable.length - 1))
      : (at === -1 ? selectable.length - 1 : Math.max(at - 1, 0))
    setChosen(selectable[next]!.folder)
    setError(null)
  }

  const optionId = (folder: string) => `${listId}-${all.findIndex((option) => option.folder === folder)}`

  return (
    <Dialog label={title} trapFocus onClose={onClose} scrimClassName="grid place-items-center" className="max-w-sm p-5">
      <h2 className="m-0 text-lg font-semibold text-text">{title}</h2>
      <p className="mt-1 mb-4 truncate text-label text-muted" title={entry.path}>{`Choose a folder for “${name}”.`}</p>
      {filtering ? (
        <div className="mb-2 flex h-9 items-center gap-2 overflow-hidden rounded-lg border border-line bg-bg px-2.5 focus-within:border-muted">
          <Icon icon={Search01Icon} size={14} className="flex-none text-dim" />
          <input
            ref={filter}
            autoFocus
            type="search"
            value={query}
            placeholder="Filter folders"
            aria-label="Filter folders"
            aria-controls={listId}
            {...active}
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-text outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:appearance-none"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeys}
          />
        </div>
      ) : null}
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label="Destination folder"
        tabIndex={filtering ? -1 : 0}
        {...active}
        className="max-h-72 overflow-y-auto rounded-lg border border-line p-1 outline-none focus-visible:border-muted"
        onKeyDown={onKeys}
      >
        {shown.length === 0 ? (
          <p role="status" className="m-0 px-2 py-1.5 text-label text-muted">No folder matches “{query}”.</p>
        ) : shown.map((option) => (
          <div
            key={option.folder || '/'}
            id={optionId(option.folder)}
            role="option"
            data-folder={option.folder}
            aria-selected={option.folder === chosen}
            aria-disabled={option.disabled || undefined}
            title={option.folder === '' ? 'The top of the vault' : option.folder}
            className={`flex h-8 min-w-0 items-center gap-2 rounded-md pr-2 text-[13px] ${
              option.disabled
                ? 'cursor-default text-dim'
                : option.folder === chosen
                  ? 'cursor-pointer bg-user-bg text-text'
                  : 'cursor-pointer text-muted hover:bg-tree-hover hover:text-text'
            }`}
            style={{ paddingLeft: 8 + option.depth * 16 }}
            onClick={() => { if (!option.disabled) { setChosen(option.folder); setError(null) } }}
            onDoubleClick={() => submit(option.folder)}
          >
            <Icon icon={Folder01Icon} size={15} className="flex-none text-dim" />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.current ? <span className="flex-none text-meta text-dim">Current</span> : null}
          </div>
        ))}
      </div>
      {error === null ? null : <p role="alert" className="mt-3 mb-0 text-label text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{pending ? 'Close' : 'Cancel'}</Button>
        <Button variant="primary" disabled={!canMove || pending || !valid} onClick={() => submit()}>{pending ? 'Moving…' : 'Move'}</Button>
      </div>
    </Dialog>
  )
}
