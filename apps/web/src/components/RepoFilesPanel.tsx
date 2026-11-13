import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  ChevronRightIcon,
  CodeIcon,
  Copy01Icon,
  EyeIcon,
  File01Icon,
  FloppyDiskIcon,
  RefreshIcon,
  Search01Icon,
  SidebarLeftIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type { RepoFileApp, RepoFileResult } from '@manor/contracts'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
} from 'react'
import { copyText } from '../clipboard'
import { FILES_TREE_WIDTH } from '../useFilesPanel'
import type { RepoFileWrite } from '../state'
import { baseName, FileMark } from './fileMark'
import { Icon } from './Icon'
import { COLUMN } from './knowledge/NoteDocument'
import { Markdown } from './Markdown'
import { RepoFileOpenMenu } from './RepoFileOpenMenu'
import { repoTreeEntries, RepoFileTree } from './RepoFileTree'
import { useCollapsed } from '../chatCollapsed'
import { Button } from './ui/Button'
import { DOCK_PANEL_SHELL, dockPanelLayoutClass } from './ui/dockPanel'
import { DockPanelAside } from './ui/DockPanelAside'
import { IconButton } from './ui/IconButton'
import { sourceTextExtensions, TextEditor } from './ui/TextEditor'

type Preview = { path: string; result: RepoFileResult | null }

const SPLIT_COLUMNS = 'grid-cols-[var(--files-tree-width)_minmax(0,1fr)]'
export const REPO_FILE_AUTOSAVE_MS = 500

/** What the editor is holding, and what it is holding it against. */
interface Editor {
  path: string
  /** What is in the editor right now. */
  text: string
  /** The same file as it stood on disk when this text was based on it. */
  disk: string
  /** The revision that text is based on, sent as the save's precondition. */
  base: string
}

/** An action held until the current draft has reached disk. */
type PendingAction =
  | { kind: 'open'; path: string }
  | { kind: 'clear' }
  | { kind: 'close' }
  | { kind: 'external'; path: string; app: RepoFileApp }

interface RepoFilesPanelProps {
  /** The chat this panel sits beside, so its file tree stays folded or shown per chat. */
  memoryKey?: string
  files?: string[]
  truncated?: boolean
  selectedPath: string | null
  preview?: Preview
  /** The answer to the last save in this project; a null result means it is in flight. */
  write?: RepoFileWrite
  /** Host-local applications, empty in a browser or while disconnected. */
  apps?: readonly RepoFileApp[]
  /** False while the socket is down, which pauses saving but preserves a local draft. */
  canEdit: boolean
  /** Only the focused thread owns window-level Save while two file panels are open. */
  shortcutsActive?: boolean
  /** Ignored while expanded: the panel is the whole stage then, not a column in it. */
  width: number
  compact?: boolean
  compactActions?: boolean
  expanded: boolean
  overlay?: boolean
  revealed?: boolean
  resizing: boolean
  resizeProps: ComponentPropsWithoutRef<'div'>
  onToggleExpanded: () => void
  onSelect: (path: string) => void
  onClearSelection: () => void
  onSave: (path: string, content: string, baseRevision: string) => boolean
  onOpenInApp?: (path: string, app: RepoFileApp) => boolean
  onClearWrite: () => void
  onClose: () => void
}

export function RepoFilesPanel({
  memoryKey,
  files,
  truncated = false,
  selectedPath,
  preview,
  write,
  apps = [],
  canEdit,
  shortcutsActive = true,
  width,
  compact = false,
  compactActions = false,
  expanded,
  overlay = false,
  revealed = true,
  resizing,
  resizeProps,
  onToggleExpanded,
  onSelect,
  onClearSelection,
  onSave,
  onOpenInApp,
  onClearWrite,
  onClose,
}: RepoFilesPanelProps) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [copied, setCopied] = useState(false)
  const [query, setQuery] = useState('')
  const [markdownView, setMarkdownView] = useState<'source' | 'read'>('read')
  const [treeHidden, setTreeHidden] = useCollapsed(memoryKey, 'files-tree')
  const [compactTree, setCompactTree] = useState(false)
  const pendingSave = useRef<{ path: string; text: string } | null>(null)
  const showTree = selectedPath === null || (compact ? compactTree : !treeHidden)
  const splitColumns = showTree && !compact

  useEffect(() => setCompactTree(false), [selectedPath])

  const result = preview?.path === selectedPath ? (preview?.result ?? null) : null
  // Only this file's answer counts. A save answered after the panel moved on belongs
  // to a file that is no longer on screen.
  const answer = write?.path === selectedPath ? write : undefined
  const writeResult = answer?.result ?? null
  const saving = answer !== undefined && writeResult === null
  const conflict = writeResult?.status === 'stale' ? writeResult : null
  const rejected = writeResult?.status === 'rejected' ? writeResult.message : null
  const dirty = editor !== null && editor.text !== editor.disk
  // A file with no revision cannot be saved without risking somebody else's work,
  // so it is not offered for editing at all.
  const editable = canEdit && result?.status === 'ready' && result.revision !== undefined
  const searching = query.trim() !== ''
  const visibleFiles = useMemo(() => filterRepoFiles(files, query), [files, query])
  const visibleFileSet = useMemo(() => new Set(visibleFiles), [visibleFiles])
  const visibleEntries = useMemo(
    () => repoTreeEntries(files ?? []).filter(({ sourcePath }) => visibleFileSet.has(sourcePath)),
    [files, visibleFileSet],
  )

  const take = useCallback(
    (next: PendingAction) => {
      if (next.kind === 'external') {
        onOpenInApp?.(next.path, next.app)
        return
      }
      setEditor(null)
      if (next.kind === 'open') {
        setCompactTree(false)
        setMarkdownView('read')
        onSelect(next.path)
      } else if (next.kind === 'clear') onClearSelection()
      else if (next.kind === 'close') onClose()
    },
    [onOpenInApp, onSelect, onClearSelection, onClose],
  )

  const save = useCallback(
    (base: string) => {
      if (editor === null || !canEdit || saving) return false
      const attempt = { path: editor.path, text: editor.text }
      pendingSave.current = attempt
      const sent = onSave(editor.path, editor.text, base)
      if (!sent) pendingSave.current = null
      return sent
    },
    [editor, canEdit, saving, onSave],
  )

  /** Every route out waits for its autosave, so a quick file switch cannot drop a final keystroke. */
  const leave = useCallback(
    (next: PendingAction) => {
      if (next.kind === 'open' && next.path === selectedPath) {
        setCompactTree(false)
        return
      }
      if (!dirty) {
        setPendingAction(null)
        take(next)
        return
      }
      setPendingAction(next)
      if (saving || conflict !== null || rejected !== null) return
      if (!save(editor.base)) setPendingAction(null)
    },
    [selectedPath, dirty, editor, saving, conflict, rejected, save, take],
  )

  // Every Markdown file enters through its reading view, including a file selected
  // while another Markdown source was open.
  useEffect(() => {
    setMarkdownView('read')
  }, [selectedPath])

  // A readable, safely revisioned file opens as an editor immediately. Clean buffers
  // follow external disk changes; typed text remains sovereign until its save answers.
  useEffect(() => {
    if (selectedPath === null) {
      setEditor(null)
      return
    }
    if (!editable || result?.status !== 'ready' || result.revision === undefined) return
    const revision = result.revision
    setEditor((current) => {
      if (current?.path !== selectedPath) {
        return { path: selectedPath, text: result.content, disk: result.content, base: revision }
      }
      if (current.text === current.disk && current.disk !== result.content) {
        return { ...current, text: result.content, disk: result.content, base: revision }
      }
      return current
    })
  }, [editable, result, selectedPath])

  // The answer to a save, and the only thing that may move the editor's idea of what
  // is on disk. A conflict deliberately does not: the text stays exactly as typed
  // until the strip below it is answered. The re-read is what keeps the reader honest,
  // because the preview underneath still holds the content from before the save.
  useEffect(() => {
    if (writeResult?.status !== 'saved' || selectedPath === null) return
    const attempt = pendingSave.current
    if (attempt === null || attempt.path !== selectedPath) return
    pendingSave.current = null
    const revision = writeResult.revision
    setEditor((current) => (current === null ? null : { ...current, disk: attempt.text, base: revision }))
    onSelect(selectedPath)
    if (pendingAction !== null && editor?.text === attempt.text) {
      const next = pendingAction
      setPendingAction(null)
      take(next)
    } else if (pendingAction !== null && editor !== null) {
      save(revision)
    }
  }, [writeResult, selectedPath, pendingAction, editor, onSelect, save, take])

  useEffect(() => {
    if (writeResult?.status !== 'rejected' && writeResult?.status !== 'stale') return
    pendingSave.current = null
    if (writeResult.status === 'rejected') setPendingAction(null)
  }, [writeResult])

  useEffect(() => {
    if (!dirty || editor === null || saving || conflict !== null || rejected !== null || pendingAction !== null) return
    const timer = window.setTimeout(() => save(editor.base), REPO_FILE_AUTOSAVE_MS)
    return () => window.clearTimeout(timer)
  }, [dirty, editor, saving, conflict, rejected, pendingAction, save])

  // ⌘S belongs to the focused thread's panel, whichever of its controls has focus.
  // Knowledge binds it too; only the focused pane's listener is armed.
  // Capture phase + stopPropagation: ⌘S is also the sidebar's shortcut (useSidebar),
  // and this panel's save has to win that race whenever it has a file open, not
  // whichever listener happened to attach first.
  useEffect(() => {
    if (selectedPath === null || !shortcutsActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        if (editor !== null && dirty && !saving) save(editor.base)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [selectedPath, editor, dirty, saving, save, shortcutsActive])

  const copyMine = () => {
    if (editor === null) return
    void copyText(editor.text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    })
  }

  const openInApp = useCallback(
    (app: RepoFileApp) => {
      if (selectedPath === null || onOpenInApp === undefined) return
      leave({ kind: 'external', path: selectedPath, app })
    },
    [selectedPath, onOpenInApp, leave],
  )

  const expandToggle = (
    <IconButton
      icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon}
      label={expanded ? 'Collapse files panel' : 'Expand files panel'}
      aria-expanded={expanded}
      onClick={onToggleExpanded}
    />
  )

  const fileActions = (
    <div
      role="toolbar"
      aria-label="File actions"
      className="flex h-11 min-w-0 items-center gap-1 px-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {selectedPath === null ? null : (
          <>
            <IconButton
              icon={SidebarLeftIcon}
              label={showTree ? 'Hide file tree' : 'Show file tree'}
              aria-pressed={showTree}
              selected={showTree}
              onClick={() => compact ? setCompactTree((current) => !current) : setTreeHidden(!treeHidden)}
            />
            <div
              className="flex h-8 min-w-0 max-w-52 items-center gap-1 rounded-button bg-surface-2 py-1 pr-1 pl-2.5 text-label text-text"
              title={selectedPath}
            >
              <span className="min-w-0 truncate">{baseName(selectedPath)}</span>
              <IconButton
                icon={Cancel01Icon}
                iconSize={13}
                size={24}
                label={`Close ${baseName(selectedPath)}`}
                onClick={() => leave({ kind: 'clear' })}
              />
            </div>
          </>
        )}
      </div>
      <div className="flex flex-none items-center gap-1">
        {editor === null ? null : (
          <>
            {saving ? <span role="status" className="flex-none px-1 text-meta text-dim">Saving…</span> : null}
            <IconButton
              icon={FloppyDiskIcon}
              label={saving ? 'Saving file' : 'Save file'}
              disabled={!canEdit || !dirty || saving || conflict !== null}
              onClick={() => save(editor.base)}
            />
          </>
        )}
        {selectedPath === null || onOpenInApp === undefined ? null : (
          <RepoFileOpenMenu apps={apps} compact={compactActions} onOpen={openInApp} />
        )}
        {expandToggle}
        <IconButton
          icon={Cancel01Icon}
          label="Close files"
          onClick={() => selectedPath === null ? onClose() : leave({ kind: 'close' })}
        />
      </div>
    </div>
  )

  const fileHeader = selectedPath === null ? null : (
    <div className="flex h-11 min-w-0 items-center gap-1 border-b border-line px-3">
      <FileBreadcrumbs path={selectedPath} />
      {!isMarkdown(selectedPath) || editor === null ? null : (
        <IconButton
          icon={markdownView === 'read' ? CodeIcon : EyeIcon}
          iconSize={17}
          label={markdownView === 'read' ? 'Edit Markdown' : 'Read Markdown'}
          swapKey={markdownView}
          aria-pressed={markdownView === 'source'}
          onClick={() => setMarkdownView((current) => current === 'read' ? 'source' : 'read')}
        />
      )}
    </div>
  )

  // Expanded, the panel leaves the grid and floats over the whole stage instead of
  // sitting beside the chat, on the same shared layout the browser panel uses: the
  // width animates between the two sizes rather than the panel leaving the grid and
  // arriving back from the window's edge. The width travels as a custom property
  // rather than an inline `width`, so the narrow breakpoint's own rule still wins;
  // an inline style would outrank it.
  return (
    <DockPanelAside
      revealed={revealed}
      style={{ '--files-width': `${width}px`, '--files-tree-width': `${FILES_TREE_WIDTH}px` } as CSSProperties}
      data-open={overlay ? revealed : undefined}
      className={`grid min-h-0 grid-rows-[auto_minmax(0,1fr)] ease-out ${DOCK_PANEL_SHELL} ${dockPanelLayoutClass(
        'w-[calc(var(--files-width)-8px)]',
        expanded,
        overlay,
        'max-w-[max(calc(100%-375px),348px)]',
      )}`}
    >
      {expanded ? null : (
        <div
          {...resizeProps}
          className="group absolute inset-y-0 left-[-4px] z-10 w-2 touch-none cursor-col-resize outline-none"
        >
          <span
            className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${
              resizing
                ? 'bg-primary'
                : 'bg-transparent group-hover:bg-muted group-focus-visible:bg-primary group-active:bg-primary'
            }`}
          />
        </div>
      )}

      <div className="border-b border-line">
        {fileActions}

        {conflict === null ? null : (
          <div className="mx-3 mb-3 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
            <p className="m-0 text-[12px] leading-relaxed text-muted">
              This file changed on disk while you were editing it. Your text is still here, so pick which one wins.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button size="small" variant="primary" disabled={saving} onClick={() => save(conflict.revision)}>
                {saving ? 'Saving…' : 'Overwrite theirs'}
              </Button>
              <Button
                size="small"
                className="inline-flex items-center gap-1.5"
                onClick={() => {
                  const next = pendingAction
                  setEditor((current) =>
                    current === null
                      ? null
                      : { ...current, text: conflict.content, disk: conflict.content, base: conflict.revision },
                  )
                  onClearWrite()
                  if (next !== null) {
                    setPendingAction(null)
                    if (next.kind !== 'external') take(next)
                  }
                }}
              >
                <Icon icon={RefreshIcon} size={13} />
                Reload theirs
              </Button>
              <Button size="small" variant="ghost" className="inline-flex items-center gap-1.5" onClick={copyMine}>
                <Icon icon={copied ? Tick02Icon : Copy01Icon} size={13} />
                {copied ? 'Copied' : 'Copy mine'}
              </Button>
            </div>
          </div>
        )}

        {rejected === null ? null : (
          <div className="mx-3 mb-3 flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] px-3.5 py-2.5">
            <p className="m-0 flex-1 text-[12px] leading-relaxed text-danger">{rejected}</p>
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                setPendingAction(null)
                onClearWrite()
              }}
            >
              Dismiss
            </Button>
          </div>
        )}
      </div>

      <div className={`grid min-h-0 ${splitColumns ? SPLIT_COLUMNS : 'grid-cols-1'}`}>
        <div
          data-files-region="tree"
          className={`${showTree ? 'grid' : 'hidden'} min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-r border-line`}
        >
          <div className="grid h-11 min-w-0 grid-cols-[minmax(0,1fr)] items-center overflow-hidden border-b border-line px-2">
            <label className="flex h-7 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-lg border border-line bg-bg px-2.5 text-muted focus-within:border-dim">
              <Icon icon={Search01Icon} size={14} className="flex-none text-dim" />
              <input
                type="search"
                value={query}
                placeholder="Search files…"
                aria-label="Search files"
                className="min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-[12px] text-text outline-none placeholder:text-dim [&::-webkit-search-cancel-button]:appearance-none"
                disabled={files === undefined}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && searching && visibleEntries[0] !== undefined) {
                    event.preventDefault()
                    leave({ kind: 'open', path: visibleEntries[0].sourcePath })
                  } else if (event.key === 'Escape' && query !== '') {
                    event.preventDefault()
                    setQuery('')
                  }
                }}
              />
            </label>
          </div>
          {/* `min-w-0` keeps a long unbreakable path from widening the tree's single
              grid column; without it the search row grows with the list and both
              clip at the divider instead of truncating. */}
          <div className="flex min-h-0 min-w-0 flex-col py-1">
            {files === undefined ? (
              <PanelMessage>Loading files…</PanelMessage>
            ) : files.length === 0 ? (
              <PanelMessage>No files found.</PanelMessage>
            ) : searching && visibleEntries.length === 0 ? (
              <PanelMessage>No files match “{query}”.</PanelMessage>
            ) : searching ? (
              <RepoFileSearchResults
                entries={visibleEntries}
                query={query}
                selectedPath={selectedPath}
                onSelect={(next) => leave({ kind: 'open', path: next })}
              />
            ) : (
              <RepoFileTree files={files} visible={showTree} onSelect={(next) => leave({ kind: 'open', path: next })} />
            )}
            {truncated ? (
              <p className="m-2 flex-none text-label leading-relaxed text-dim">Only the first 4,000 files are shown.</p>
            ) : null}
          </div>
        </div>

        <div
          data-files-region="viewer"
          className={`${compact && showTree ? 'hidden' : 'grid'} relative min-h-0 min-w-0 ${selectedPath === null ? 'grid-rows-[minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]'}`}
        >
          {fileHeader}
          <div className="relative grid min-h-0 min-w-0">
            {selectedPath === null && !searching && files !== undefined && files.length > 0 ? (
              <div className="grid min-h-0 place-items-center px-6 text-center">
                <div className="flex flex-col items-center">
                  <Icon icon={File01Icon} size={24} className="mb-3 text-dim" />
                  <p className="m-0 text-[13px] font-medium text-text">Open a file</p>
                  <p className="mt-1 mb-0 text-[12px] text-dim">Select a file from the workspace tree.</p>
                </div>
              </div>
            ) : selectedPath !== null && editor === null ? (
              <FilePreview path={selectedPath} result={result} />
            ) : selectedPath !== null && editor !== null ? (
              <>
                <div
                  className={`${isMarkdown(editor.path) && markdownView === 'read' ? 'hidden' : ''} min-h-0 overflow-y-auto bg-stage px-5 py-4`}
                >
                  <TextEditor
                    path={editor.path}
                    text={editor.text}
                    extensions={sourceTextExtensions(editor.path, { lineNumbers: !isMarkdown(editor.path) })}
                    onChange={(text) => setEditor((current) => (current === null ? null : { ...current, text }))}
                  />
                </div>
                {isMarkdown(editor.path) && markdownView === 'read' ? <MarkdownReadView text={editor.text} /> : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </DockPanelAside>
  )
}

// Wraps every case-insensitive occurrence of `match` so the row shows why it
// qualified; the caller passes the same trimmed term `filterRepoFiles` used.
function highlightMatches(text: string, match: string, className: string) {
  const lower = text.toLocaleLowerCase()
  if (match === '' || !lower.includes(match)) return text
  const parts: React.ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(match); at !== -1; at = lower.indexOf(match, from)) {
    if (at > from) parts.push(text.slice(from, at))
    from = at + match.length
    parts.push(
      <span key={at} className={className}>
        {text.slice(at, from)}
      </span>,
    )
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

function RepoFileSearchResults({
  entries,
  query,
  selectedPath,
  onSelect,
}: {
  entries: ReturnType<typeof repoTreeEntries>
  query: string
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  const match = query.trim().toLocaleLowerCase()
  return (
    <div role="listbox" aria-label="File search results" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-2">
      {entries.map(({ displayPath, sourcePath }) => {
        const name = baseName(displayPath)
        const directory = displayPath.slice(0, Math.max(0, displayPath.length - name.length - 1))
        return (
          <button
            key={sourcePath}
            type="button"
            role="option"
            aria-selected={sourcePath === selectedPath}
            title={sourcePath}
            className={`flex h-8 w-full flex-none min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md border-0 px-2 text-left font-sans text-[12px] ${
              sourcePath === selectedPath ? 'bg-user-bg text-text' : 'bg-transparent text-muted hover:bg-tree-hover hover:text-text'
            }`}
            onClick={() => onSelect(sourcePath)}
          >
            <FileMark path={sourcePath} size={14} className="opacity-75" />
            <span className="min-w-0 max-w-[50%] shrink truncate">
              {highlightMatches(name, match, 'font-semibold text-text')}
            </span>
            {directory === '' ? null : (
              <span className="min-w-0 flex-1 truncate text-dim">
                {highlightMatches(directory, match, 'font-semibold text-muted')}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function FileBreadcrumbs({ path }: { path: string }) {
  const segments = path.split('/').filter(Boolean)
  const parents = segments.slice(0, -1)
  const file = segments.at(-1) ?? path

  return (
    <nav
      className="flex min-w-0 flex-1 items-center overflow-hidden text-meta"
      aria-label="File path"
      title={path}
    >
      <span dir="rtl" className="flex min-w-0 shrink-[9999] items-center overflow-hidden text-muted">
        <span dir="ltr" className="flex min-w-max items-center">
          {parents.map((segment, index) => (
            <span key={`${segment}-${index}`} className="flex items-center">
              <span>{segment}</span>
              <Icon icon={ChevronRightIcon} size={12} className="mx-1 flex-none text-dim" />
            </span>
          ))}
        </span>
      </span>
      <span className="min-w-0 shrink truncate font-medium text-text" aria-current="page">
        {file}
      </span>
    </nav>
  )
}

export function filterRepoFiles(files: readonly string[] | undefined, query: string): string[] {
  if (files === undefined) return []
  const match = query.trim().toLocaleLowerCase()
  if (match === '') return [...files]
  return repoTreeEntries(files)
    .filter(({ displayPath }) => displayPath.toLocaleLowerCase().includes(match))
    .map(({ sourcePath }) => sourcePath)
}

function FilePreview({ path, result }: { path: string; result: RepoFileResult | null }) {
  if (result === null) return <PanelMessage>Loading file…</PanelMessage>

  switch (result.status) {
    case 'ready':
      return isMarkdown(path) ? (
        <MarkdownReadView text={result.content} />
      ) : (
        // CodeMirror is also the reader, so a language cannot change colour or
        // geometry when Edit is pressed. Long lines wrap in both modes because this
        // panel is often narrower than the source it shows.
        <div className="min-h-0 overflow-y-auto bg-stage p-4">
          <TextEditor path={path} text={result.content} extensions={sourceTextExtensions(path)} />
        </div>
      )
    case 'too_large':
      return <PanelMessage>This file is {formatBytes(result.size)}. Previews stop at {formatBytes(result.maxSize)}.</PanelMessage>
    case 'binary':
      return <PanelMessage>This binary file cannot be previewed.</PanelMessage>
    case 'unavailable':
      return <PanelMessage>{result.message}</PanelMessage>
  }
}

function MarkdownReadView({ text }: { text: string }) {
  return (
    <div className="min-h-0 overflow-y-auto bg-stage px-5 py-4">
      <article className={`mx-auto w-full ${COLUMN} text-[16px] leading-[1.7] text-text`}>
        <Markdown text={text} variant="document" />
      </article>
    </div>
  )
}

function PanelMessage({ children }: { children: React.ReactNode }) {
  return <p className="m-0 px-5 py-4 text-[12px] leading-relaxed text-dim">{children}</p>
}

const isMarkdown = (path: string) => /\.(?:md|mdx|markdown)$/i.test(path)

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}
