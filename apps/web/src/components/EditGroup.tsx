import { ChevronRightIcon, PencilEdit02Icon } from '@hugeicons/core-free-icons'
import type { FileEdit } from '@manor/contracts'
import { useMemo, useState, type ReactNode } from 'react'
import { changedFiles, changedTotals, type ChangedFile } from '../changedFiles'
import { Icon } from './Icon'
import { FileDiff } from './FileDiff'

/**
 * A run of file changes, sitting in the turn's flow between the sentences that
 * explain it.
 *
 * Per file, never per call. Ten rows of "Edited index.ts" record how the model
 * happened to split its patches, which is the one thing nobody wants to know; one row
 * saying `index.ts +89 −31` answers what actually changed and opens to those ten if
 * the reader wants the receipts. Above that, more than one file collapses to the
 * claim — this many files, this much either way — because at that size the question
 * is which files, and that is one click away rather than ten rows of paths pushing
 * the next sentence off the screen.
 *
 * Every count here states the rows it opens to, so a number is never a promise the
 * fold cannot keep.
 */
export function EditGroup({ edits, unfolded = false }: { edits: FileEdit[]; unfolded?: boolean }) {
  const files = useMemo(() => changedFiles(edits), [edits])
  const [open, setOpen] = useState(false)
  const first = files[0]
  if (first === undefined) return null

  // The activity accordion is already the fold. Once it is open, putting another
  // count in front of its files is a second click to reach the list it promised.
  if (unfolded) {
    return (
      <div className="flex flex-col gap-1">
        {files.map((file) => (
          <Row key={file.raw}>
            <FileRow file={file} />
          </Row>
        ))}
      </div>
    )
  }

  if (files.length === 1) {
    return (
      <Row>
        <FileRow file={first} />
      </Row>
    )
  }

  const totals = changedTotals(files)
  return (
    <Row>
      <button
        type="button"
        className="group flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-[12px]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-dim group-hover:text-text">Changed {files.length} files</span>
        <Stat added={totals.added} removed={totals.removed} />
        <Chevron open={open} />
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1">
          {files.map((file) => (
            <FileRow key={file.raw} file={file} />
          ))}
        </div>
      ) : null}
    </Row>
  )
}

/** The pencil and the indent every row in this group hangs off. */
function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-[12px]">
      <span className="mt-[3px] shrink-0 text-dim">
        <Icon icon={PencilEdit02Icon} size={14} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * One file. Touched once it is the change itself, opening straight to the diff, since
 * a fold in front of a single hunk is a click that buys nothing. Touched several
 * times it states the file and its summed counts, and opens to the hunks in the order
 * they were written — never merged into one diff, which would invent lines nobody
 * wrote.
 */
function FileRow({ file }: { file: ChangedFile }) {
  const [open, setOpen] = useState(false)
  const single = file.edits.length === 1 ? file.edits[0] : undefined
  // The single hunk keeps `editVerb`: only it can tell a whole-file write from an
  // edit, and "Wrote" is a distinction worth not flattening into "Edited".
  if (single !== undefined) return <FileDiff edit={single} verb={editVerb(single)} flush />

  return (
    <div>
      <button
        type="button"
        className="group flex w-full min-w-0 cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 border-0 bg-transparent p-0 text-left text-[12px]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shrink-0 text-dim group-hover:text-muted">{fileVerb(file)}</span>
        <span className="min-w-0 truncate text-muted group-hover:text-text">{baseName(file.path)}</span>
        <Stat added={file.added} removed={file.removed} />
        <span className="shrink-0 text-dim">{file.edits.length} changes</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1">
          {file.edits.map((edit, index) => (
            <FileDiff key={`${file.raw}-${index}`} edit={edit} verb={editVerb(edit)} flush />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="shrink-0 text-dim transition-colors group-hover:text-muted">
      <Icon
        icon={ChevronRightIcon}
        size={12}
        className={`duration-200 ease-overshoot motion-safe:transition-transform ${open ? 'rotate-90' : ''}`}
      />
    </span>
  )
}

function Stat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <>
      {added === 0 ? null : <span className="shrink-0 text-ok">+{added}</span>}
      {removed === 0 ? null : <span className="shrink-0 text-danger">−{removed}</span>}
    </>
  )
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** The one word for a file the turn touched several times, from the same reading of
 *  the same fields `editVerb` uses, so the row and the hunks under it agree. */
function fileVerb(file: ChangedFile): string {
  if (file.status === 'created') return 'Created'
  if (file.status === 'deleted') return 'Deleted'
  return 'Edited'
}

/**
 * Three verbs, because the driver knows three things. "Created" is a claim and is
 * only made when the driver checked; "Wrote" is the honest word for a whole-file
 * write whose previous contents nobody handed us — it says what happened without
 * pretending to know whether the file was there first.
 */
export function editVerb(edit: FileEdit): string {
  if (edit.kind === 'add' || edit.created === true) return 'Created'
  if (edit.kind === 'delete' || (edit.kind === undefined && edit.after === undefined)) return 'Deleted'
  if (edit.kind === 'update') return 'Edited'
  if (edit.before === undefined) return 'Wrote'
  return 'Edited'
}
