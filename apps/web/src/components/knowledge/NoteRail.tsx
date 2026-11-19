import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { VaultState } from '../../state'
import { ContextMenu } from '../ui/ContextMenu'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Cancel01Icon, Delete02Icon, FolderAddIcon, FolderExportIcon, Note01Icon, NoteAddIcon, PencilEdit02Icon, Search01Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons'
import { Icon } from '../Icon'
import { buildTree, FileTree, folderPaths, type TreeDrag, type TreeNode } from '../ui/FileTree'
import { IconButton } from '../ui/IconButton'
import { insideVaultEntry } from '@manor/client-runtime/state'
import { MoveDialog, parentFolder } from './MoveDialog'

/** The drag's own type, so a file dragged in from Finder is never read as a move. */
export const ENTRY_DRAG = 'application/x-manor-vault-entry'
/** How long a drag rests on a closed folder before it opens. */
export const FOLDER_OPEN_DELAY_MS = 700

interface NoteRailProps {
  actionSlot?: HTMLElement | null | undefined
  vaultName: string | null
  folders: string[]
  previews: Record<string, string>
  folderWrite: VaultState['folderWrite']
  /** This client's own delete and its answer. */
  deletion: VaultState['deletion']
  /** Where a delete moves things, named in the confirm. */
  trash: string | null
  /** Sends a delete; false when the socket is down. */
  onDelete: (requestId: string, path: string) => boolean
  onCreateAt: (path: string) => void
  onRename: (path: string) => void
  /** This client's own move and its answer. */
  move: VaultState['move']
  /** Sends a move into `folder` (`''` is the top level); false when the socket is down. */
  onMove: (requestId: string, path: string, folder: string, notify: boolean) => boolean
  onCreateFolder: (path: string) => boolean
  onFolderCreated: (path: string) => void
  /** Null until the listing lands, which is not the same as an empty vault. */
  files: string[] | null
  truncated: boolean
  filter: string
  onFilter: (value: string) => void
  tree: TreeNode[]
  openFolders: Set<string>
  onToggleFolder: (path: string) => void
  selectedPath: string | null
  dirtyPath: string | null
  onSelect: (path: string) => void
  /** Where notes open in tabs: ⌘-click or a middle click opens one in a new tab. */
  onOpenInNewTab?: (path: string) => void
  /** Makes a new note in the vault's inbox and opens it. */
  onCreate: () => void
  canCreate: boolean
  /** A create is out and unanswered, so the button stops inviting a second one. */
  creating: boolean
  filterRef: React.RefObject<HTMLInputElement>
  /**
   * The phone drawer's handle, which lives here because on the phone this rail is the
   * top-left corner of the Knowledge page and there is no header above it to hold one.
   */
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  /**
   * `sidebar`: inside the workspace sidebar, which already names the destination and
   * holds its controls. `page`: the phone's Knowledge page, naming itself. `dock`:
   * beside a thread, search and new-note only, Files-style.
   */
  variant: 'sidebar' | 'page' | 'dock'
}

/**
 * The rail: every note in the vault, filtered by whole path. Narrow on purpose — it
 * is a way back to the document column, not a second place to read.
 */
export function NoteRail({
  vaultName,
  actionSlot,
  folders,
  previews,
  folderWrite,
  deletion,
  trash,
  onDelete,
  onCreateAt,
  onRename,
  move,
  onMove,
  onCreateFolder,
  onFolderCreated,
  files,
  truncated,
  filter,
  onFilter,
  tree,
  openFolders,
  onToggleFolder,
  selectedPath,
  dirtyPath,
  onSelect,
  onOpenInNewTab,
  onCreate,
  canCreate,
  creating,
  filterRef,
  sidebarCollapsed = false,
  onToggleSidebar,
  variant,
}: NoteRailProps) {
  const embedded = variant === 'dock'
  const [menu, setMenu] = useState<{ path: string; kind: 'file' | 'folder' | 'root'; x: number; y: number } | null>(null)
  const [removing, setRemoving] = useState<{ path: string; kind: 'file' | 'folder'; requestId: string | null; error: string | null } | null>(null)
  const [create, setCreate] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [moving, setMoving] = useState<{ path: string; kind: 'file' | 'folder' } | null>(null)
  const [dragged, setDragged] = useState<{ path: string; file: boolean } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const opening = useRef<{ folder: string; timer: number } | null>(null)
  const stopOpening = () => {
    if (opening.current !== null) window.clearTimeout(opening.current.timer)
    opening.current = null
  }
  useEffect(() => stopOpening, [])
  useEffect(() => {
    if (pending === null || folderWrite?.path !== pending || folderWrite.result === null) return
    setPending(null)
    if (folderWrite.result.status === 'rejected') { setError(folderWrite.result.message); return }
    setCreate(null)
    onFolderCreated(pending)
  }, [folderWrite, pending, onFolderCreated])
  useEffect(() => {
    if (canCreate || pending === null) return
    setPending(null)
    setError('Connection lost. Check the folder list after reconnecting before trying again.')
  }, [canCreate, pending])
  useEffect(() => {
    if (removing?.requestId == null || deletion?.requestId !== removing.requestId || deletion.result === null) return
    if (deletion.result.status === 'rejected') setRemoving({ ...removing, requestId: null, error: deletion.result.message })
    else setRemoving(null)
  }, [deletion, removing])
  useEffect(() => {
    if (canCreate || removing?.requestId == null) return
    setRemoving({ ...removing, requestId: null, error: 'Connection lost. Check the tree after reconnecting before trying again.' })
  }, [canCreate, removing])
  const confirmDelete = () => {
    if (removing === null || removing.requestId !== null) return
    const requestId = crypto.randomUUID()
    if (onDelete(requestId, removing.path)) setRemoving({ ...removing, requestId, error: null })
    else setRemoving({ ...removing, error: 'Reconnect before deleting.' })
  }
  const startCreate = (kind: 'file' | 'folder', parent: string) => {
    setCreate({ kind, parent }); setName(''); setError(null)
  }
  const submit = () => {
    if (create === null || pending !== null) return
    const trimmed = name.trim()
    if (!trimmed || trimmed.startsWith('.') || /[/\\\0]/.test(trimmed)) {
      setError('Enter a name without slashes or a leading dot.'); return
    }
    const filename = create.kind === 'file' && !/\.md$/i.test(trimmed) ? `${trimmed}.md` : trimmed
    const path = create.parent === '' ? filename : `${create.parent}/${filename}`
    if (new TextEncoder().encode(filename).length > 255 || path.length > 1_000) {
      setError('That name is too long. Use a shorter name.'); return
    }
    if ([...(files ?? []), ...folders].some((entry) => entry.toLowerCase() === path.toLowerCase())) {
      setError('A file or folder with that name already exists.'); return
    }
    if (create.kind === 'file') { onCreateAt(path); setCreate(null); return }
    if (onCreateFolder(path)) setPending(path)
    else setError('Reconnect before creating a folder.')
  }
  const busy = !canCreate || creating || pending !== null
  const canMove = canCreate && !creating

  /** Whether `folder` would take the dragged entry: not where it already is, not inside itself. */
  const takes = (folder: string) =>
    dragged !== null && parentFolder(dragged.path) !== folder && (dragged.file || !insideVaultEntry(folder, dragged.path))
  const ours = (event: DragEvent<HTMLElement>) => dragged !== null && event.dataTransfer.types.includes(ENTRY_DRAG)
  const finishDrag = () => {
    stopOpening()
    setDragged(null)
    setDropTarget(null)
  }
  const dropInto = (folder: string, event: DragEvent<HTMLElement>) => {
    if (!ours(event)) return
    event.preventDefault()
    const source = dragged
    finishDrag()
    if (source === null || !takes(folder) || !canMove) return
    onMove(crypto.randomUUID(), source.path, folder, true)
  }
  const drag: TreeDrag = {
    canDrag: () => canMove,
    source: dragged?.path ?? null,
    target: dropTarget,
    start: (path, file, event) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(ENTRY_DRAG, path)
      // The picture under the pointer is the entry's name, not a snapshot of the row.
      const ghost = window.document.createElement('div')
      const name = path.split('/').at(-1) ?? path
      ghost.textContent = file ? name.replace(/\.md$/i, '') : name
      ghost.className = 'fixed -top-96 left-0 max-w-64 truncate rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] font-medium text-text'
      window.document.body.append(ghost)
      event.dataTransfer.setDragImage(ghost, 12, 12)
      window.setTimeout(() => ghost.remove(), 0)
      setDragged({ path, file })
    },
    end: finishDrag,
    overFolder: (folder, open, event) => {
      if (!ours(event)) return
      // The tree's empty area is the top level; a folder row answers for itself.
      event.stopPropagation()
      if (!open && opening.current?.folder !== folder && !(dragged !== null && !dragged.file && insideVaultEntry(folder, dragged.path))) {
        stopOpening()
        opening.current = {
          folder,
          timer: window.setTimeout(() => {
            opening.current = null
            onToggleFolder(folder)
          }, FOLDER_OPEN_DELAY_MS),
        }
      }
      if (!takes(folder)) {
        if (dropTarget !== null) setDropTarget(null)
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (dropTarget !== folder) setDropTarget(folder)
    },
    leaveFolder: (folder, event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      if (opening.current?.folder === folder) stopOpening()
      setDropTarget((current) => (current === folder ? null : current))
    },
    dropOnFolder: (folder, event) => {
      event.stopPropagation()
      dropInto(folder, event)
    },
  }
  const createButton = (
    <>
      <IconButton
        icon={NoteAddIcon}
        iconSize={17}
        label="New note in the inbox"
        title="New note in the inbox"
        disabled={!canCreate || creating}
        className="disabled:cursor-default disabled:opacity-40"
        onClick={onCreate}
      />
      <IconButton
        icon={FolderAddIcon}
        iconSize={17}
        label="New folder"
        title="New folder"
        disabled={busy}
        className="disabled:cursor-default disabled:opacity-40"
        onClick={() => startCreate('folder', '')}
      />
    </>
  )
  return (
    // The explicit `minmax(0,1fr)` column is load bearing. An implicit `auto` track
    // sizes to its content's max-content width, so the longest note name in the vault
    // was making this track 290px wide inside a 260px rail: the names were clipped at
    // the border rather than ellipsised, and no amount of `truncate` fixes that,
    // because the box being overflowed is the track and not the row.
    <div className={`grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] ${variant === 'page' ? 'border-r border-line bg-surface' : ''}`}>
      {variant === 'sidebar' && actionSlot != null ? createPortal(createButton, actionSlot) : null}
      <div
        className={
          variant === 'sidebar'
            // Pinned under the sidebar's title while the tree scrolls beneath it.
            ? 'sticky top-0 z-[1] bg-sidebar pb-2'
            : `border-b border-line ${
              embedded
                ? 'grid h-11 items-center px-2'
                : sidebarCollapsed
                  ? 'px-3 pb-2.5 pt-[var(--titlebar-row-pad)] pl-[calc(1rem+var(--titlebar-inset))]'
                  : 'px-3 pt-3 pb-2.5'
            }`
        }
      >
        {variant !== 'page' ? null : (
        <div className="mb-2.5 flex items-center gap-2 px-0.5">
          {sidebarCollapsed && onToggleSidebar !== undefined ? (
            <IconButton
              icon={SidebarLeftIcon}
              iconSize={17}
              label="Show sidebar"
              title="Show sidebar (⌘S)"
              onClick={onToggleSidebar}
            />
          ) : null}
          <Icon icon={Note01Icon} size={17} className="flex-none text-muted" />
          <h1 className="m-0 min-w-0 flex-1 text-[14px] font-semibold tracking-[-0.01em] text-text">Knowledge</h1>
          {createButton}
        </div>
        )}

        <div className="flex items-center gap-1">
          <div className={`flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-lg border border-line bg-bg px-2.5 focus-within:border-muted ${embedded ? 'h-7' : 'h-9'}`}>
            <Icon icon={Search01Icon} size={14} className="flex-none text-dim" />
            <input
              ref={filterRef}
              type="search"
              value={filter}
              placeholder="Filter notes by name"
              title={vaultName === null ? 'Filter notes by file name or folder' : `Filter ${vaultName} by file name or folder`}
              aria-label="Filter notes"
              className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-text outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:appearance-none"
              onChange={(event) => onFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || filter === '') return
                event.preventDefault()
                onFilter('')
              }}
            />
            {filter === '' ? null : (
              <IconButton icon={Cancel01Icon} iconSize={13} size={24} label="Clear note filter" onClick={() => { onFilter(''); filterRef.current?.focus() }} />
            )}
          </div>
          {embedded ? createButton : null}
        </div>
      </div>

      <div
        className={`min-h-0 min-w-0 rounded-lg duration-150 ease-fade motion-safe:transition-colors ${variant === 'sidebar' ? '' : 'overflow-y-auto px-2 py-2'} ${dropTarget === '' ? 'bg-user-bg/50' : ''}`}
        onDragOver={(event) => {
          if (!ours(event)) return
          // Over a note row the drop means nothing: only folders and the empty area take it.
          if ((event.target as HTMLElement).closest('[data-tree-path]') !== null || !takes('')) {
            stopOpening()
            if (dropTarget !== null) setDropTarget(null)
            return
          }
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          if (dropTarget !== '') setDropTarget('')
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={(event) => dropInto('', event)}
        onContextMenu={(event) => {
          // A row's own menu already took the event; this is the empty area.
          if (event.defaultPrevented || !canCreate) return
          event.preventDefault()
          setMenu({ path: '', kind: 'root', x: event.clientX, y: event.clientY })
        }}
      >
        {files === null ? (
          <RailMessage>Reading the vault…</RailMessage>
        ) : files.length === 0 && folders.length === 0 ? (
          <RailMessage>This vault has no notes yet.</RailMessage>
        ) : tree.length === 0 ? (
          <RailMessage>No note matches “{filter}”.</RailMessage>
        ) : (
          <FileTree
            label="Vault notes"
            notePreviews={previews}
            onFolderMenu={(path, position) => setMenu({ path, kind: 'folder', ...position })}
            onFileMenu={(path, position) => setMenu({ path, kind: 'file', ...position })}
            nodes={tree}
            openFolders={openFolders}
            onToggleFolder={onToggleFolder}
            onSelect={onSelect}
            {...(onOpenInNewTab === undefined ? {} : { onOpenInNewTab })}
            selectedPath={selectedPath}
            dirtyPath={dirtyPath}
            drag={drag}
          />
        )}
        {truncated ? (
          <p className="m-2 text-label leading-relaxed text-dim">
            This vault is larger than the tree shows; only the first notes are listed.
          </p>
        ) : null}
      </div>
      {menu === null ? null : <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menu.kind === 'root' ? [
        { label: 'New folder…', icon: FolderAddIcon, disabled: busy, onSelect: () => startCreate('folder', '') },
        { label: 'New note…', icon: NoteAddIcon, disabled: busy, onSelect: () => startCreate('file', '') },
      ] : menu.kind === 'file' ? [
        { label: 'Rename', icon: PencilEdit02Icon, disabled: !canCreate || creating, onSelect: () => onRename(menu.path) },
        { label: 'Move to…', icon: FolderExportIcon, disabled: !canMove, onSelect: () => setMoving({ path: menu.path, kind: 'file' }) },
        { label: 'Delete…', icon: Delete02Icon, tone: 'danger', disabled: !canCreate || creating, onSelect: () => setRemoving({ path: menu.path, kind: 'file', requestId: null, error: null }) },
      ] : [
        { label: 'New note…', icon: NoteAddIcon, disabled: busy, onSelect: () => startCreate('file', menu.path) },
        { label: 'New folder…', icon: FolderAddIcon, disabled: busy, onSelect: () => startCreate('folder', menu.path) },
        { label: 'Move to…', icon: FolderExportIcon, disabled: busy, onSelect: () => setMoving({ path: menu.path, kind: 'folder' }) },
        { label: 'Delete…', icon: Delete02Icon, tone: 'danger', disabled: busy, onSelect: () => setRemoving({ path: menu.path, kind: 'folder', requestId: null, error: null }) },
      ]} />}
      {moving === null ? null : <MoveDialog entry={moving} folders={folders} move={move} canMove={canMove} onMove={onMove} onClose={() => setMoving(null)} />}
      {removing === null ? null : <Dialog label={removing.kind === 'file' ? 'Delete note' : 'Delete folder'} trapFocus onClose={() => setRemoving(null)} scrimClassName="grid place-items-center" className="max-w-sm p-5">
        <h2 className="m-0 text-lg font-semibold text-text">{removing.kind === 'file' ? 'Delete note' : 'Delete folder'}</h2>
        <p className="mt-2 mb-0 text-label leading-relaxed text-muted">{deleteQuestion(removing.path, removing.kind, files ?? [], folders, trash, truncated)}</p>
        {removing.error === null ? null : <p role="alert" className="mt-3 mb-0 text-label text-danger">{removing.error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button autoFocus variant="secondary" onClick={() => setRemoving(null)}>{removing.requestId === null ? 'Cancel' : 'Close'}</Button>
          <Button variant="danger" disabled={!canCreate || removing.requestId !== null} onClick={confirmDelete}>{removing.requestId === null ? 'Move to trash' : 'Moving…'}</Button>
        </div>
      </Dialog>}
      {create === null ? null : <Dialog label={create.kind === 'file' ? 'New note' : 'New folder'} trapFocus onClose={() => setCreate(null)} scrimClassName="grid place-items-center" className="max-w-sm p-5">
        <form onSubmit={(event) => { event.preventDefault(); submit() }}>
          <h2 className="m-0 text-lg font-semibold text-text">{create.kind === 'file' ? 'New note' : 'New folder'}</h2>
          <p className="mt-1 mb-4 truncate text-label text-muted" title={create.parent || (vaultName ?? '')}>{create.parent === '' ? `At the top of ${vaultName ?? 'the vault'}` : `In ${create.parent}`}</p>
          <label className="grid gap-1.5 text-label text-text">Name
            <input autoFocus value={name} disabled={pending !== null} onChange={(event) => { setName(event.target.value); setError(null) }} className="w-full rounded-md border border-line bg-bg px-3 py-2 text-text outline-none focus:border-muted" />
          </label>
          {error === null ? null : <p role="alert" className="text-label text-danger">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreate(null)}>{pending === null ? 'Cancel' : 'Close'}</Button>
            <Button type="submit" variant="primary" disabled={!canCreate || pending !== null || name.trim() === ''}>{pending === null ? 'Create' : 'Creating…'}</Button>
          </div>
        </form>
      </Dialog>}
    </div>
  )
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The confirm's one sentence: what goes, how much goes with a folder, and where it goes.
 * Counted from the tree, which lists notes only, so other files inside are named too.
 */
/** `truncated` is the listing's cap flag: the counts are then a floor, not a total. */
export function deleteQuestion(path: string, kind: 'file' | 'folder', files: readonly string[], folders: readonly string[], trash: string | null, truncated = false): string {
  const name = path.split('/').at(-1) ?? path
  const where = trash === null ? "Manor's trash folder" : `Manor's trash at ${trash}`
  if (kind === 'file') return `Delete “${name}”? It moves to ${where}, so you can get it back from there.`
  const notes = files.filter((file) => file.startsWith(`${path}/`)).length
  const inner = folders.filter((folder) => folder.startsWith(`${path}/`)).length
  const counted = inner === 0 ? count(notes, 'note', 'notes') : `${count(notes, 'note', 'notes')} and ${count(inner, 'folder', 'folders')}`
  const holds = truncated ? `at least ${counted}` : notes === 0 && inner === 0 ? 'no notes' : counted
  return `Delete the folder “${name}” with ${holds}? It moves to ${where} with its folders kept, together with any other files inside it.`
}

function RailMessage({ children }: { children: React.ReactNode }) {
  return <p role="status" className="m-0 px-2.5 py-2 text-[12px] leading-relaxed text-muted">{children}</p>
}

/** The rail's own view of the vault: filtered by whole path, with every parent opened. */
export function filterNotes(files: readonly string[], filter: string, folders: readonly string[] = []): { tree: TreeNode[]; expandAll: string[] } {
  const query = filter.trim().toLowerCase()
  const matched = query === '' ? files : files.filter((path) => path.toLowerCase().includes(query))
  const tree = buildTree(matched, query === '' ? folders : folders.filter((path) => path.toLowerCase().includes(query)))
  // A filter that matched something three folders deep has to show it, so filtering
  // opens every folder that survived rather than asking for three clicks.
  return { tree, expandAll: query === '' ? [] : folderPaths(tree) }
}
