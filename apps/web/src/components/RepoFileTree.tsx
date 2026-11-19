import type { CSSProperties, DragEvent, MouseEvent } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { FileTree, useFileTree } from '@pierre/trees/react'

const treeStyle = {
  '--trees-bg-override': 'transparent',
  '--trees-fg-override': 'var(--color-muted)',
  '--trees-selected-bg-override': 'var(--color-user-bg)',
  '--trees-bg-muted-override': 'var(--color-tree-hover)',
  '--trees-border-color-override': 'var(--color-line)',
  '--trees-font-family-override': 'var(--font-sans)',
  '--trees-font-size-override': '14px',
  '--trees-padding-inline-override': '8px',
} as CSSProperties

const treeCSS = `
  [data-icon-name="file-tree-icon-chevron"] {
    width: 12px;
    height: 12px;
  }
`

/** The drag type of a file dragged out of the tree; its data is the file's repository path. */
export const REPO_FILE_DRAG = 'application/x-manor-repo-file'

/** The display path of the tree row an event came from, through the tree's shadow root. */
const rowPathOf = (event: Event) => {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLElement && node.dataset.itemPath !== undefined) return node.dataset.itemType === 'file' ? node.dataset.itemPath : null
  }
  return null
}

interface RepoTreeEntry {
  displayPath: string
  sourcePath: string
}

function singleRepoRoot(files: readonly string[]): string | undefined {
  const roots = new Set(files.map((file) => file.split('/')[0]).filter(Boolean))
  return roots.size === 1 ? [...roots][0] : undefined
}

/** A single linked folder is already implied by the panel, so its root is visual noise. */
export function repoTreeEntries(files: readonly string[]): RepoTreeEntry[] {
  const root = singleRepoRoot(files)
  return files.map((sourcePath) => ({
    sourcePath,
    displayPath: root !== undefined && sourcePath.startsWith(`${root}/`)
      ? sourcePath.slice(root.length + 1)
      : sourcePath,
  }))
}

interface RepoFileTreeProps {
  files: readonly string[]
  /** The open file, which the tree keeps selected. */
  selectedPath?: string | null
  onSelect: (path: string) => void
  /** A ⌘-click or middle click on a file. */
  onOpenInNewTab?: (path: string) => void
  visible?: boolean
}

/** The project explorer uses Trees' own compact rows, navigation, and directory flattening. */
export function RepoFileTree({ files, selectedPath = null, onSelect, onOpenInNewTab, visible = true }: RepoFileTreeProps) {
  const entries = useMemo(() => repoTreeEntries(files), [files])
  const filesRef = useRef(new Map(entries.map(({ displayPath, sourcePath }) => [displayPath, sourcePath])))
  const onSelectRef = useRef(onSelect)
  // Selection the panel makes itself, or a drag's own pick of the dragged row, opens nothing.
  const quiet = useRef(false)
  filesRef.current = new Map(entries.map(({ displayPath, sourcePath }) => [displayPath, sourcePath]))
  onSelectRef.current = onSelect

  const displayPaths = useMemo(() => entries.map(({ displayPath }) => displayPath), [entries])
  const initialFiles = useRef(files)
  const { model } = useFileTree({
    paths: displayPaths,
    density: 'compact',
    itemHeight: 32,
    flattenEmptyDirectories: true,
    initialExpansion: singleRepoRoot(files) === undefined ? 1 : 0,
    icons: { set: 'complete', colored: true },
    unsafeCSS: treeCSS,
    // Rows drag out onto the panel's tab strip; nothing moves inside the tree.
    dragAndDrop: { canDrag: (paths) => paths.every((path) => filesRef.current.has(path)), canDrop: () => false },
    onSelectionChange: (selectedPaths) => {
      if (quiet.current) return
      const selectedPath = selectedPaths.at(-1)
      const sourcePath = selectedPath === undefined ? undefined : filesRef.current.get(selectedPath)
      if (sourcePath !== undefined) onSelectRef.current(sourcePath)
    },
  })

  useEffect(() => {
    if (initialFiles.current === files) return
    initialFiles.current = files
    model.resetPaths(displayPaths)
  }, [files, model])

  useEffect(() => {
    if (visible) return
    // Returning to the compact list must let the current file be opened again.
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect()
  }, [visible, model])

  // The open file stays the selected row, whichever tab or route opened it.
  const showSelected = () => {
    const display = selectedPath === null ? undefined : entries.find((entry) => entry.sourcePath === selectedPath)?.displayPath
    const selected = model.getSelectedPaths()
    if (selected.length === (display === undefined ? 0 : 1) && (display === undefined || selected[0] === display)) return
    quiet.current = true
    for (const path of selected) model.getItem(path)?.deselect()
    if (display !== undefined) {
      // A file inside a folded folder unfolds its way to the row, so the mark shows.
      const folders = display.split('/').slice(0, -1)
      for (const [index] of folders.entries()) {
        const folder = model.getItem(`${folders.slice(0, index + 1).join('/')}/`)
        if (folder !== null && 'expand' in folder && !folder.isExpanded()) folder.expand()
      }
      model.getItem(display)?.select()
    }
    quiet.current = false
  }
  useEffect(showSelected, [selectedPath, entries, model])

  const sourceOf = (event: Event) => {
    const display = rowPathOf(event)
    return display === null ? undefined : filesRef.current.get(display)
  }
  const openInNewTab = (event: MouseEvent<HTMLDivElement>) => {
    const source = onOpenInNewTab === undefined ? undefined : sourceOf(event.nativeEvent)
    if (source === undefined) return
    event.preventDefault()
    event.stopPropagation()
    onOpenInNewTab?.(source)
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col"
      // Captured before the tree sees it, so ⌘-click opens a tab instead of adding to the selection.
      onClickCapture={(event) => { if (event.metaKey || event.ctrlKey) openInNewTab(event) }}
      onAuxClick={(event) => { if (event.button === 1) openInNewTab(event) }}
      onDragStartCapture={() => { quiet.current = true }}
      onDragEnd={() => { quiet.current = false; showSelected() }}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        const source = sourceOf(event.nativeEvent)
        // A refused drag (a folder) never ends with dragend.
        if (event.defaultPrevented || source === undefined) quiet.current = false
        else event.dataTransfer.setData(REPO_FILE_DRAG, source)
      }}>
      <FileTree
        model={model}
        aria-label="Repository files"
        className="min-h-0 w-full flex-1 overflow-hidden"
        style={treeStyle}
      />
    </div>
  )
}
