import { ArrowRight01Icon, Folder01Icon, FolderOpenIcon } from '@hugeicons/core-free-icons'
import { useCallback, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { FileMark } from '../fileMark'
import { Icon } from '../Icon'

export interface TreeNode {
  name: string
  path: string
  file: boolean
  children: TreeNode[]
}

/** Folder-first, then alphabetical, at every level. */
export function buildTree(files: readonly string[], folders: readonly string[] = []): TreeNode[] {
  const root: TreeNode = { name: '', path: '', file: false, children: [] }
  for (const filePath of [...folders.map((folder) => `${folder}/`), ...files]) {
    const parts = filePath.split('/').filter(Boolean)
    let parent = root
    for (const [index, name] of parts.entries()) {
      const nodePath = parts.slice(0, index + 1).join('/')
      let child = parent.children.find((candidate) => candidate.name === name)
      if (child === undefined) {
        child = { name, path: nodePath, file: index === parts.length - 1 && !filePath.endsWith('/'), children: [] }
        parent.children.push(child)
      }
      parent = child
    }
  }
  sortTree(root)
  return root.children
}

function sortTree(node: TreeNode) {
  node.children.sort(
    (left, right) => Number(left.file) - Number(right.file) || left.name.localeCompare(right.name, 'en'),
  )
  for (const child of node.children) sortTree(child)
}

/** Every folder path in a tree, for the "expand everything" the filter needs. */
export function folderPaths(nodes: readonly TreeNode[]): string[] {
  const paths: string[] = []
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (node.file) continue
      paths.push(node.path)
      walk(node.children)
    }
  }
  walk(nodes)
  return paths
}

const NOTE_NAME = 'text-[14px] font-medium text-text'

const ROW = 'h-8 text-[14px]'

/**
 * Native drag and drop for a tree whose entries can move into folders. The tree only
 * reports; the caller decides what may be dragged, which folder takes the drop and
 * what the drop does. Absent, rows are not draggable at all.
 */
export interface TreeDrag {
  /** Whether this entry can be picked up. */
  canDrag: (path: string, file: boolean) => boolean
  /** The entry being dragged, dimmed where it stands. */
  source: string | null
  /** The folder that would take the drop, which wears the drop highlight. */
  target: string | null
  start: (path: string, file: boolean, event: DragEvent<HTMLElement>) => void
  end: () => void
  overFolder: (path: string, open: boolean, event: DragEvent<HTMLElement>) => void
  leaveFolder: (path: string, event: DragEvent<HTMLElement>) => void
  dropOnFolder: (path: string, event: DragEvent<HTMLElement>) => void
}

interface FileTreeProps {
  label: string
  nodes: TreeNode[]
  /** Controlled, because a filter has opinions about what should be open. */
  openFolders: Set<string>
  onToggleFolder: (path: string) => void
  onSelect: (path: string) => void
  /** The file this tree is showing; absent in a tree that only opens things. */
  selectedPath?: string | null
  /** The one file with unsaved edits, which wears a dot rather than a second colour. */
  dirtyPath?: string | null
  /** Knowledge shows titles and short excerpts; repository trees keep file glyphs. */
  notePreviews?: Readonly<Record<string, string>>
  onFileMenu?: (path: string, position: { x: number; y: number }) => void
  onFolderMenu?: (path: string, position: { x: number; y: number }) => void
  drag?: TreeDrag
}

/**
 * The shared file tree. One roving tabindex for the whole thing, so a keyboard lands
 * on the tree once and then moves inside it with the arrows, instead of tabbing
 * through three hundred notes to reach the composer.
 */
export function FileTree({
  label,
  nodes,
  openFolders,
  onToggleFolder,
  onSelect,
  selectedPath = null,
  dirtyPath = null,
  notePreviews,
  onFolderMenu,
  onFileMenu,
  drag,
}: FileTreeProps) {
  const rows = useMemo(() => flatten(nodes, openFolders), [nodes, openFolders])
  const container = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState<string | null>(null)
  // The one row Tab lands on: wherever the arrows left off, else the open note, else
  // the top. Tabbing out of a tree and back must not throw the reader to row one.
  const visible = (path: string | null) => path !== null && rows.some((row) => row.node.path === path)
  const stop = visible(focused) ? focused : visible(selectedPath) ? selectedPath : (rows[0]?.node.path ?? null)

  // By dataset rather than by selector: a note path carries slashes, spaces and the
  // occasional quote, and none of them survive being spliced into one.
  const focusRow = useCallback((path: string) => {
    const rowsInDom = container.current?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? []
    for (const element of rowsInDom) {
      if (element.dataset['treePath'] !== path) continue
      element.focus()
      return
    }
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const path = (event.target as HTMLElement).dataset['treePath']
    if (path === undefined) return
    const index = rows.findIndex((row) => row.node.path === path)
    if (index === -1) return
    const row = rows[index] as Row
    const open = openFolders.has(row.node.path)

    switch (event.key) {
      case 'ArrowDown':
        step(rows, index + 1, focusRow)
        break
      case 'ArrowUp':
        step(rows, index - 1, focusRow)
        break
      case 'ArrowRight':
        if (row.node.file) return
        if (open) step(rows, index + 1, focusRow)
        else onToggleFolder(row.node.path)
        break
      case 'ArrowLeft':
        if (!row.node.file && open) {
          onToggleFolder(row.node.path)
          break
        }
        // Out to the folder this row sits in, which is the nearest shallower row above.
        for (let above = index - 1; above >= 0; above -= 1) {
          const candidate = rows[above] as Row
          if (candidate.depth < row.depth) {
            focusRow(candidate.node.path)
            break
          }
        }
        break
      case 'Home':
        step(rows, 0, focusRow)
        break
      case 'End':
        step(rows, rows.length - 1, focusRow)
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div
      ref={container}
      role="tree"
      aria-label={label}
      onKeyDown={handleKeyDown}
      onFocus={(event) => setFocused((event.target as HTMLElement).dataset['treePath'] ?? null)}
    >
      {rows.map((row, index) =>
        row.node.file ? (
          <FileRow
            key={row.node.path}
            row={row}
            guides={notePreviews === undefined ? null : <FolderGuides depth={row.depth} previousDepth={rows[index - 1]?.depth ?? 0} nextDepth={rows[index + 1]?.depth ?? 0} />}
            selected={row.node.path === selectedPath}
            dirty={row.node.path === dirtyPath}
            tabStop={row.node.path === stop}
            onSelect={onSelect}
            {...(drag === undefined ? {} : { drag })}
            {...(onFileMenu === undefined ? {} : { onMenu: onFileMenu })}
            {...(notePreviews === undefined ? {} : { preview: notePreviews[row.node.path] ?? '' })}
          />
        ) : (
          <FolderRow
            key={row.node.path}
            row={row}
            guides={notePreviews === undefined ? null : <FolderGuides depth={row.depth} previousDepth={rows[index - 1]?.depth ?? 0} nextDepth={rows[index + 1]?.depth ?? 0} />}
            open={openFolders.has(row.node.path)}
            tabStop={row.node.path === stop}
            noteStyle={notePreviews !== undefined}
            onToggle={onToggleFolder}
            {...(drag === undefined ? {} : { drag })}
            {...(onFolderMenu === undefined ? {} : { onMenu: onFolderMenu })}
          />
        ),
      )}
    </div>
  )
}

function FileRow({
  row,
  selected,
  dirty,
  tabStop,
  onSelect,
  preview,
  onMenu,
  guides,
  drag,
}: {
  row: Row
  selected: boolean
  dirty: boolean
  tabStop: boolean
  onSelect: (path: string) => void
  preview?: string
  onMenu?: FileTreeProps['onFileMenu']
  guides: ReactNode
  drag?: TreeDrag
}) {
  const draggable = drag?.canDrag(row.node.path, true) === true
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      aria-level={row.depth + 1}
      data-tree-path={row.node.path}
      tabIndex={tabStop ? 0 : -1}
      // Selection is a fill, hover is a fill; the selected row keeps its own rather
      // than flickering to the hover one under the pointer that just clicked it.
      className={`relative flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 pr-2 text-left ${preview === undefined ? ROW : 'min-h-14 py-2 text-[14px]'} ${
        selected ? 'bg-user-bg text-text' : 'bg-transparent text-muted hover:bg-tree-hover hover:text-text'
      } ${drag?.source === row.node.path ? 'opacity-50' : ''}`}
      style={{ paddingLeft: 8 + row.depth * 16 }}
      title={row.node.path}
      draggable={draggable}
      {...(drag === undefined || !draggable ? {} : {
        onDragStart: (event: DragEvent<HTMLElement>) => drag.start(row.node.path, true, event),
        onDragEnd: drag.end,
      })}
      onClick={() => onSelect(row.node.path)}
      onContextMenu={onMenu === undefined ? undefined : (event) => {
        event.preventDefault()
        event.currentTarget.focus()
        onMenu(row.node.path, { x: event.clientX, y: event.clientY })
      }}
      onKeyDown={onMenu === undefined ? undefined : (event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        const bounds = event.currentTarget.getBoundingClientRect()
        onMenu(row.node.path, { x: bounds.left + 16, y: bounds.bottom })
      }}
    >
      {guides}
      {preview === undefined ? <FileMark path={row.node.path} size={15} /> : null}
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${preview === undefined ? '' : NOTE_NAME}`}>{preview === undefined ? row.node.name : row.node.name.replace(/\.md$/i, '')}</span>
        {preview === undefined || preview === '' ? null : <span className="mt-0.5 block truncate text-[12px] leading-[1.4] font-normal text-muted">{preview}</span>}
      </span>
      {dirty ? (
        <span
          aria-label="Unsaved changes"
          title="Unsaved changes"
          className="h-1.5 w-1.5 flex-none rounded-full bg-text/70"
        />
      ) : null}
    </button>
  )
}

function FolderRow({
  row,
  open,
  tabStop,
  onToggle,
  onMenu,
  noteStyle,
  guides,
  drag,
}: {
  row: Row
  open: boolean
  tabStop: boolean
  onToggle: (path: string) => void
  onMenu?: FileTreeProps['onFolderMenu']
  noteStyle: boolean
  guides: ReactNode
  drag?: TreeDrag
}) {
  const draggable = drag?.canDrag(row.node.path, false) === true
  const target = drag?.target === row.node.path
  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={open}
      aria-level={row.depth + 1}
      data-tree-path={row.node.path}
      tabIndex={tabStop ? 0 : -1}
      className={`relative flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 pr-2 text-left font-medium duration-150 ease-out motion-safe:transition-colors ${
        target ? 'bg-user-bg text-text' : 'bg-transparent text-muted hover:bg-tree-hover hover:text-text'
      } ${drag?.source === row.node.path ? 'opacity-50' : ''} ${ROW}`}
      style={{ paddingLeft: 4 + row.depth * 16 }}
      draggable={draggable}
      {...(drag === undefined ? {} : {
        ...(draggable ? { onDragStart: (event: DragEvent<HTMLElement>) => drag.start(row.node.path, false, event), onDragEnd: drag.end } : {}),
        onDragOver: (event: DragEvent<HTMLElement>) => drag.overFolder(row.node.path, open, event),
        onDragLeave: (event: DragEvent<HTMLElement>) => drag.leaveFolder(row.node.path, event),
        onDrop: (event: DragEvent<HTMLElement>) => drag.dropOnFolder(row.node.path, event),
      })}
      onClick={() => onToggle(row.node.path)}
      onContextMenu={onMenu === undefined ? undefined : (event) => {
        event.preventDefault()
        event.currentTarget.focus()
        onMenu(row.node.path, { x: event.clientX, y: event.clientY })
      }}
      onKeyDown={onMenu === undefined ? undefined : (event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        const bounds = event.currentTarget.getBoundingClientRect()
        onMenu(row.node.path, { x: bounds.left + 16, y: bounds.bottom })
      }}
    >
      {guides}
      <Icon icon={ArrowRight01Icon} size={12} className={`flex-none duration-200 ease-overshoot motion-safe:transition-transform ${open ? 'rotate-90' : ''}`} />
      <Icon icon={open ? FolderOpenIcon : Folder01Icon} size={15} className="flex-none text-dim" />
      <span className={`min-w-0 truncate ${noteStyle ? NOTE_NAME : ''}`}>{row.node.name}</span>
    </button>
  )
}

/** Same one-pixel, two-on/three-off rail as the session sidebar's subagents. */
function FolderGuides({ depth, previousDepth, nextDepth }: { depth: number; previousDepth: number; nextDepth: number }) {
  return Array.from({ length: depth }, (_, ancestor) => (
    <span
      key={ancestor}
      aria-hidden="true"
      className="pointer-events-none absolute w-px bg-[repeating-linear-gradient(to_bottom,color-mix(in_srgb,var(--color-dim)_45%,transparent)_0_2px,transparent_2px_5px)]"
      style={{ left: 10 + ancestor * 16, top: previousDepth <= ancestor ? 4 : 0, bottom: nextDepth <= ancestor ? 4 : 0 }}
    />
  ))
}

interface Row {
  node: TreeNode
  depth: number
}

/**
 * The tree as the rows actually on screen. Flat, because arrow keys move between
 * what is visible, and a folded folder's children are not that.
 */
function flatten(nodes: readonly TreeNode[], openFolders: Set<string>, depth = 0, into: Row[] = []): Row[] {
  for (const node of nodes) {
    into.push({ node, depth })
    if (!node.file && openFolders.has(node.path)) flatten(node.children, openFolders, depth + 1, into)
  }
  return into
}

function step(rows: Row[], index: number, focusRow: (path: string) => void) {
  const target = rows[index]
  if (target !== undefined) focusRow(target.node.path)
}
