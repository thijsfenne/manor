import { ArrowRight01Icon, Folder01Icon, FolderOpenIcon, GitCompareIcon } from '@hugeicons/core-free-icons'
import { useMemo, useState } from 'react'
import { changedGroups, changedTotals, changedTree, type ChangedFile, type ChangedNode } from '../changedFiles'
import { baseName, FileMark } from './fileMark'
import { DiffBody } from './FileDiff'
import { Icon } from './Icon'
import { useDiffReview } from './session/diffReview'

interface ChangedFilesProps {
  files: ChangedFile[]
  /** Absent where there is no files panel to open into, which makes the rows inert. */
  onOpenFile?: (panelPath: string) => void
  /** The turn these files belong to, so Review can open its diff beside the chat. */
  turnId?: string
}

/** How many names the closed card shows before it stops listing and starts counting. */
const CHIPS = 3

/**
 * What a finished turn changed, under the answer that explains it.
 *
 * Closed by default and closed is the normal state: the claim is the headline —
 * this many files, this much either way — and the tree under it is for the reader
 * who wants to check. Two ways to check, because there are two questions: the name
 * opens the file as it stands now, in the files panel, and the counts unfold what
 * this turn did to it, in place.
 */
export function ChangedFiles({ files, onOpenFile, turnId }: ChangedFilesProps) {
  const review = useDiffReview()
  const [open, setOpen] = useState(false)
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const totals = useMemo(() => changedTotals(files), [files])
  const tree = useMemo(() => changedTree(files), [files])
  const groups = useMemo(() => changedGroups(files), [files])
  const chips = useMemo(
    () => [...files].sort((left, right) => baseName(left.path).localeCompare(baseName(right.path), 'en')),
    [files],
  )

  if (files.length === 0) return null

  const toggleFolder = (key: string) =>
    setFolded((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  return (
    <div className="min-w-0 rounded-xl border border-line bg-composer-tray p-2 text-[12px]">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded-md border-0 bg-transparent px-1 py-0.5 text-left [font:inherit]"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="shrink-0 text-dim transition-colors group-hover:text-muted">
            <Icon
              icon={ArrowRight01Icon}
              size={13}
              className={`duration-200 ease-overshoot motion-safe:transition-transform ${open ? 'rotate-90' : ''}`}
            />
          </span>
          <span className="shrink-0 font-medium text-text">
            {files.length} changed {files.length === 1 ? 'file' : 'files'}
          </span>
          <Stat added={totals.added} removed={totals.removed} />
          {files.some((file) => file.diffTruncated) ? <span className="shrink-0 whitespace-nowrap text-warn">Partial diff</span> : null}
          {/* The first to give way when Review shares a narrow row. */}
          <span className="ml-1 min-w-0 truncate text-dim group-hover:text-muted">{open ? 'Hide files' : 'Show files'}</span>
        </button>
        {/* The whole turn in the diff pane beside the chat, every file in one list. */}
        {review === undefined || turnId === undefined ? null : (
          <button
            type="button"
            title="Review this turn's changes beside the chat"
            aria-label={`Review ${files.length === 1 ? baseName(files[0]!.path) : `${baseName(chips[0]!.path)} and ${files.length - 1} more`}`}
            onClick={() => review(turnId)}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-dim [font:inherit] hover:bg-surface-2 hover:text-text"
          >
            <Icon icon={GitCompareIcon} size={13} />
            Review
          </button>
        )}
      </div>

      {open ? (
        <div className="mt-1.5">
          {tree.map((node) => (
            <Row key={node.key} node={node} depth={0} folded={folded} onToggle={toggleFolder} onOpenFile={onOpenFile} />
          ))}
        </div>
      ) : (
        <div className="mt-2 flex min-w-0 flex-col gap-1.5 px-1">
          {/* One group is the card's own count again, so it prints no header. */}
          {groups.length < 2 ? null : (
            <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-dim">
              {groups.map((group, index) => (
                <span key={group.name} className="flex items-center gap-1.5">
                  <span className="font-mono text-muted">{group.name}</span>
                  <span>
                    {group.count} {group.count === 1 ? 'file' : 'files'}
                  </span>
                </span>
              ))}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.slice(0, CHIPS).map((file) => (
              <Name
                key={file.raw}
                file={file}
                className="rounded-md border border-line px-2 py-[3px]"
                onOpenFile={onOpenFile}
              />
            ))}
            {files.length > CHIPS ? (
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent px-1 py-[3px] text-dim [font:inherit] hover:text-text"
                onClick={() => setOpen(true)}
              >
                Show all {files.length} files
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

/** One step of nesting. Files sit a step further in than the folder that holds them,
 *  which is where the folder's own chevron would be if a file had one. */
const STEP = 16
const NO_CHEVRON = 18

function Row({
  node,
  depth,
  folded,
  onToggle,
  onOpenFile,
}: {
  node: ChangedNode
  depth: number
  folded: Set<string>
  onToggle: (key: string) => void
  onOpenFile?: (panelPath: string) => void
}) {
  if (node.file !== undefined) return <FileRow file={node.file} depth={depth} onOpenFile={onOpenFile} />

  const open = !folded.has(node.key)
  return (
    <>
      <div
        className="group flex min-w-0 items-center gap-2 rounded-md pr-2 hover:bg-surface-2"
        style={{ paddingLeft: depth * STEP }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent py-[3px] pr-1 text-left [font:inherit]"
          aria-expanded={open}
          onClick={() => onToggle(node.key)}
        >
          <Icon
            icon={ArrowRight01Icon}
            size={12}
            className={`flex-none text-dim duration-200 ease-overshoot motion-safe:transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <Icon icon={open ? FolderOpenIcon : Folder01Icon} size={14} className="flex-none text-dim" />
          <span className="min-w-0 truncate font-mono text-muted group-hover:text-text">{node.name}</span>
        </button>
        <Stat added={node.added} removed={node.removed} />
      </div>
      {open
        ? node.children.map((child) => (
            <Row
              key={child.key}
              node={child}
              depth={depth + 1}
              folded={folded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </>
  )
}

/**
 * A file, and the two different things a reader wants from it. The name is the file
 * as it stands now and opens it in the panel; the counts are what this turn did to
 * it and unfold the diff in place. Two targets in one row rather than one that has
 * to guess, and the row lights up as a whole so it is clear they belong together.
 */
function FileRow({
  file,
  depth,
  onOpenFile,
}: {
  file: ChangedFile
  depth: number
  onOpenFile?: (panelPath: string) => void
}) {
  const [open, setOpen] = useState(false)
  const indent = depth * STEP + NO_CHEVRON
  const hasDiff = (file.added + file.removed > 0 && file.edits.length > 0) || file.diffTruncated === true

  return (
    <>
      <div
        className="group flex min-w-0 items-center gap-2 rounded-md pr-2 hover:bg-surface-2"
        style={{ paddingLeft: indent }}
      >
        <Name file={file} className="min-w-0 flex-1 py-[3px]" onOpenFile={onOpenFile} />
        {hasDiff ? (
          <button
            type="button"
            className="group/diff flex cursor-pointer items-center gap-1.5 border-0 bg-transparent py-[3px] pl-1 [font:inherit]"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the changes to ${baseName(file.path)}`}
            title={open ? 'Hide the diff' : 'Show the diff'}
            onClick={() => setOpen((value) => !value)}
          >
            {/* Only under the pointer or the keyboard: twelve permanent chevrons in a
                column read as a second tree, and the counts are the target anyway. */}
            <Icon
              icon={ArrowRight01Icon}
              size={12}
              className={`flex-none text-dim opacity-0 duration-200 ease-overshoot motion-safe:transition-[transform,opacity] group-hover:opacity-100 group-focus-visible/diff:opacity-100 ${
                open ? 'rotate-90 opacity-100' : ''
              }`}
            />
            <Stat added={file.added} removed={file.removed} />
          </button>
        ) : (
          <Stat added={file.added} removed={file.removed} />
        )}
      </div>
      {open ? (
        // Each hunk as the driver reported it, in order. Four calls into one file are
        // four boxes, because merging them would invent lines nobody wrote.
        <div className="mt-1 mb-2 flex flex-col gap-1" style={{ paddingLeft: indent }}>
          {file.edits.map((edit, index) => (
            <DiffBody key={`${file.raw}-${index}`} edit={edit} />
          ))}
          {file.diffTruncated ? <p className="m-0 text-warn">Part of this diff was too large to show.</p> : null}
        </div>
      ) : null}
    </>
  )
}

/**
 * The filename, and where it can be opened it is the way in. A file Manor could not
 * place in a linked folder — a memory write, a path outside the project — states
 * itself and does nothing, rather than offering a click that lands on an error.
 */
function Name({
  file,
  className = '',
  onOpenFile,
}: {
  file: ChangedFile
  className?: string
  onOpenFile?: (panelPath: string) => void
}) {
  const panelPath = file.panelPath
  const openable = panelPath !== undefined && onOpenFile !== undefined && file.status !== 'deleted'
  const inner = (
    <>
      <FileMark path={file.path} size={14} />
      <span className="min-w-0 truncate font-mono">{baseName(file.path)}</span>
      {file.status === 'edited' ? null : (
        <span className="flex-none text-dim">{file.status === 'created' ? 'new' : 'deleted'}</span>
      )}
      {file.diffTruncated ? <span className="flex-none text-warn">partial</span> : null}
    </>
  )

  if (!openable) {
    return (
      <span className={`flex min-w-0 items-center gap-2 text-muted ${className}`} title={file.raw}>
        {inner}
      </span>
    )
  }

  return (
    <button
      type="button"
      className={`flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-muted [font:inherit] hover:text-text ${className}`}
      title={`Open ${file.raw}`}
      onClick={() => onOpenFile(panelPath)}
    >
      {inner}
    </button>
  )
}

function Stat({ added, removed, className = '' }: { added: number; removed: number; className?: string }) {
  if (added === 0 && removed === 0) return null
  return (
    <span className={`flex flex-none items-center gap-2 tabular-nums ${className}`}>
      {added === 0 ? null : <span className="text-ok">+{added}</span>}
      {removed === 0 ? null : <span className="text-danger">−{removed}</span>}
    </span>
  )
}
