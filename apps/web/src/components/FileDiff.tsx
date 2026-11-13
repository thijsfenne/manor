import { ChevronRightIcon } from '@hugeicons/core-free-icons'
import type { FileEdit } from '@manor/contracts'
import { useMemo, useState } from 'react'
import { collapseContext, editLines, editStat, numberedDiff } from '@manor/client-runtime/diff'
import { Icon } from './Icon'

/**
 * One file change. Closed it is a claim — this name, and when the provider supplied
 * contents, this many lines either way. Open is the evidence only in that second
 * case. Closed by default: six diffs would bury the trace under evidence nobody asked
 * to read.
 */
interface FileDiffProps {
  edit: FileEdit
  /** Names the action in the header, for the caller that folded its own label into
   *  this row rather than printing "Edited x" and then a box that also says x. */
  verb?: string
  /** Drops the top margin, for that same caller: the row itself is the spacing. */
  flush?: boolean
}
/** Past this the diff scrolls inside itself. A 400-line rewrite is one step in a turn,
 *  and a step that pushes every later step off the screen has stopped being a trace. */
const MAX_DIFF_PX = 380

export function FileDiff({ edit, verb, flush = false }: FileDiffProps) {
  const [open, setOpen] = useState(false)
  // Shared with the turn's own file summary, which has already counted this edit.
  const stat = editStat(edit)
  // Never inferred from a missing `before`: a whole-file write has no before side
  // either, and calling that a new file is how an overwrite came to read "new file".
  const created = edit.kind === 'add' || edit.created === true
  const deleted = edit.kind === 'delete' || (edit.kind === undefined && edit.after === undefined)
  const hasDiff = stat.added + stat.removed > 0

  return (
    <div className={flush ? '' : 'mt-1.5'}>
      <button
        type="button"
        className="group flex w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 border-0 bg-transparent p-0 text-left text-[12px] disabled:cursor-default"
        aria-expanded={deleted || !hasDiff ? undefined : open}
        disabled={deleted || !hasDiff}
        onClick={() => setOpen((value) => !value)}
      >
        {verb === undefined ? null : <span className="shrink-0 text-dim group-hover:text-muted">{verb}</span>}
        {/* The name, not the path: `truncate` clips the end, so a full absolute path
            renders as the one part nobody needs and hides the filename. The path
            itself is worth a line, but only once the diff is open. */}
        <span className="min-w-0 truncate text-muted group-hover:text-text">
          {edit.path.split(/[\\/]/).filter(Boolean).at(-1) ?? edit.path}
        </span>
        {/* Only where the verb is not already carrying it. */}
        {created && verb === undefined ? <span className="shrink-0 text-dim">new file</span> : null}
        {deleted && verb === undefined ? <span className="shrink-0 text-dim">deleted</span> : null}
        {stat.added === 0 ? null : <span className="shrink-0 text-ok">+{stat.added}</span>}
        {stat.removed === 0 ? null : <span className="shrink-0 text-danger">−{stat.removed}</span>}
        {deleted || !hasDiff ? null : (
          <span className="shrink-0 text-dim transition-colors group-hover:text-muted">
            <Icon
              icon={ChevronRightIcon}
              size={12}
              className={`duration-200 ease-overshoot motion-safe:transition-transform ${open ? 'rotate-90' : ''}`}
            />
          </span>
        )}
      </button>
      {deleted || !hasDiff || !open ? null : (
        <>
          <p className="mt-1 mb-1 truncate font-mono text-meta text-dim" title={edit.path}>
            {edit.path}
          </p>
          <DiffBody edit={edit} />
        </>
      )}
    </div>
  )
}

/**
 * The change itself, without a header. Two surfaces ask for it now — the row in the
 * trace and the file summary a finished turn ends with — and the second is why this
 * is its own component rather than markup inside the first: a diff that looked
 * different depending on which of the two you opened it from would read as two
 * different records of one edit.
 */
export function DiffBody({ edit }: { edit: FileEdit }) {
  const lines = useMemo(() => editLines(edit), [edit])
  const rows = useMemo(() => numberedDiff(collapseContext(lines), edit.offset), [lines, edit.offset])
  const gutter = `${String(rows.reduce((widest, row) => Math.max(widest, row.number ?? 0), 0)).length}ch`

  return (
    <>
      <div className="overflow-y-auto rounded-md border border-line" style={{ maxHeight: MAX_DIFF_PX }}>
        <pre className="m-0 py-1 font-mono text-meta leading-[1.5]">
          {rows.map((row, index) =>
            row.kind === 'gap' ? (
              <div key={`gap-${index}`} className="select-none px-2 text-dim">
                ⋯ {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
              </div>
            ) : (
              <div
                key={`${row.kind}-${index}`}
                className={
                  row.kind === 'added'
                    ? 'flex bg-[color-mix(in_srgb,var(--color-ok)_15%,transparent)] px-2 text-ok'
                    : row.kind === 'removed'
                      ? 'flex bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)] px-2 text-danger'
                      : 'flex px-2 text-dim'
                }
              >
                <span className="mr-2 shrink-0 select-none text-right text-dim diff-quiet" style={{ width: gutter }}>
                  {row.number}
                </span>
                <span className="shrink-0 select-none diff-quiet">
                  {row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '}
                </span>
                {/* Wraps rather than scrolls: a diff you have to drag sideways to read
                    is a diff nobody reads. The gutter and sign hold their own columns,
                    so a wrapped line lands under the text it continues. */}
                <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere">
                  {row.text === '' ? ' ' : row.text}
                </span>
              </div>
            ),
          )}
        </pre>
      </div>
      {edit.truncated ? (
        <p className="mt-1 mb-0 text-label text-warn">
          The change was too long to store in full; the rest is not shown.
        </p>
      ) : null}
    </>
  )
}
