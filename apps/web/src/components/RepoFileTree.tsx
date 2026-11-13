import type { CSSProperties } from 'react'
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
  onSelect: (path: string) => void
  visible?: boolean
}

/** The project explorer uses Trees' own compact rows, navigation, and directory flattening. */
export function RepoFileTree({ files, onSelect, visible = true }: RepoFileTreeProps) {
  const entries = useMemo(() => repoTreeEntries(files), [files])
  const filesRef = useRef(new Map(entries.map(({ displayPath, sourcePath }) => [displayPath, sourcePath])))
  const onSelectRef = useRef(onSelect)
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
    onSelectionChange: (selectedPaths) => {
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

  return (
    <FileTree
      model={model}
      aria-label="Repository files"
      className="min-h-0 w-full flex-1 overflow-hidden"
      style={treeStyle}
    />
  )
}
