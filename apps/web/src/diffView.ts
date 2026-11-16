import type { SessionDiffFile } from '@manor/contracts'
import { collapseContext, editLines } from '@manor/client-runtime/diff'
import type { ChangedFile } from './changedFiles'

/**
 * One line of a file card. Removed lines carry their old number, added lines their new
 * one, unchanged lines both. A gap stands for unchanged lines left out between hunks;
 * its count is absent where the source did not say how many.
 */
export type DiffViewRow =
  | { kind: 'same'; text: string; oldNo?: number; newNo?: number }
  | { kind: 'removed'; text: string; oldNo?: number }
  | { kind: 'added'; text: string; newNo?: number }
  | { kind: 'gap'; count?: number }

/** A file as the diff pane shows it, whichever scope it came from. */
export interface DiffViewFile {
  key: string
  /** As the card heads it: repo-relative, with the folder's name when a Session has several. */
  path: string
  /** What the Files panel opens and an `@` reference names. */
  panelPath?: string
  oldPath?: string
  status: 'created' | 'deleted' | 'edited'
  added: number
  removed: number
  binary: boolean
  /** Part of this file's diff is not here. */
  truncated: boolean
  /** The turn's diff budget ran out before this file, so none of its lines were read. */
  skipped?: true
  /** Changed in the Session but left out of the result waiting for Confirm. */
  excluded?: true
  rows: DiffViewRow[]
}

/** Context kept around a change when a tool reported a whole block rather than a hunk. */
const CONTEXT = 3

/** The whole-Session diff as Git wrote it: numbers from each hunk's header, gaps between. */
export function sessionDiffView(files: readonly SessionDiffFile[]): DiffViewFile[] {
  const roots = new Set(files.map((file) => file.root))
  return files.map((file) => {
    const rows: DiffViewRow[] = []
    let nextOld = 1
    for (const hunk of file.hunks) {
      const skipped = hunk.oldStart - nextOld
      if (skipped > 0 || rows.length > 0) rows.push({ kind: 'gap', ...(skipped > 0 ? { count: skipped } : {}) })
      let oldNo = hunk.oldStart
      let newNo = hunk.newStart
      for (const line of hunk.lines) {
        const text = line.slice(1)
        if (line[0] === '-') rows.push({ kind: 'removed', text, oldNo: oldNo++ })
        else if (line[0] === '+') rows.push({ kind: 'added', text, newNo: newNo++ })
        else rows.push({ kind: 'same', text, oldNo: oldNo++, newNo: newNo++ })
      }
      nextOld = oldNo
    }
    return {
      key: `${file.root}\0${file.path}`,
      path: roots.size > 1 ? file.panelPath ?? file.path : file.path,
      ...(file.panelPath === undefined ? {} : { panelPath: file.panelPath }),
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      status: file.status,
      added: file.added,
      removed: file.removed,
      binary: file.binary === true,
      truncated: file.truncated === true,
      ...(file.excluded === true ? { excluded: true as const } : {}),
      rows,
    }
  })
}

/**
 * One turn's files, from the hunks the turn's own snapshot recorded (or the edits a tool
 * reported where Git could not measure). Each edit is its own hunk, as on the card.
 * `panelPaths` are the server's own Files paths by raw path: the card keeps only those
 * in the composer's listing, which can be older than the turn that created the file.
 */
export function turnDiffView(files: readonly ChangedFile[], panelPaths?: ReadonlyMap<string, string>): DiffViewFile[] {
  return files.map((file) => {
    const panelPath = file.panelPath ?? panelPaths?.get(file.raw)
    const rows: DiffViewRow[] = []
    for (const edit of file.edits) {
      if (rows.length > 0) rows.push({ kind: 'gap' })
      let oldNo = edit.offset?.before
      let newNo = edit.offset?.after
      for (const line of collapseContext(editLines(edit), CONTEXT)) {
        if (line.kind === 'gap') {
          if (oldNo !== undefined) oldNo += line.count
          if (newNo !== undefined) newNo += line.count
          rows.push({ kind: 'gap', count: line.count })
        } else if (line.kind === 'removed') {
          rows.push({ kind: 'removed', text: line.text, ...(oldNo === undefined ? {} : { oldNo: ++oldNo }) })
        } else if (line.kind === 'added') {
          rows.push({ kind: 'added', text: line.text, ...(newNo === undefined ? {} : { newNo: ++newNo }) })
        } else {
          rows.push({
            kind: 'same', text: line.text,
            ...(oldNo === undefined ? {} : { oldNo: ++oldNo }),
            ...(newNo === undefined ? {} : { newNo: ++newNo }),
          })
        }
      }
    }
    return {
      key: panelPath ?? file.raw,
      path: file.path,
      ...(panelPath === undefined ? {} : { panelPath }),
      status: file.status,
      added: file.added,
      removed: file.removed,
      binary: false,
      truncated: file.diffTruncated === true,
      ...(file.diffSkipped ? { skipped: true as const } : {}),
      rows,
    }
  })
}

const squeezed = (lines: readonly string[]) => lines.join('').replace(/\s+/g, '')

/**
 * Hides changes that only moved whitespace, for a scope Git did not diff with `-w`: a
 * removed run and the added run after it that read the same without whitespace become
 * unchanged lines. A file left with nothing changed is dropped and counted, unless it
 * was created, deleted or cut short, which is a change whatever its lines say.
 */
export function withoutWhitespaceChanges(files: readonly DiffViewFile[]): { files: DiffViewFile[]; hidden: number } {
  let hidden = 0
  const kept: DiffViewFile[] = []
  for (const file of files) {
    // No lines to read (skipped, binary, too large): the recorded counts are all there is.
    if (file.rows.length === 0) {
      kept.push(file)
      continue
    }
    const rows: DiffViewRow[] = []
    for (let at = 0; at < file.rows.length;) {
      const row = file.rows[at]!
      if (row.kind !== 'removed') {
        rows.push(row)
        at += 1
        continue
      }
      let end = at
      while (file.rows[end]?.kind === 'removed') end += 1
      let addedEnd = end
      while (file.rows[addedEnd]?.kind === 'added') addedEnd += 1
      const removed = file.rows.slice(at, end) as Extract<DiffViewRow, { kind: 'removed' }>[]
      const added = file.rows.slice(end, addedEnd) as Extract<DiffViewRow, { kind: 'added' }>[]
      if (added.length > 0 && squeezed(removed.map((line) => line.text)) === squeezed(added.map((line) => line.text))) {
        added.forEach((line, index) => {
          const oldNo = removed[Math.min(index, removed.length - 1)]?.oldNo
          rows.push({ kind: 'same', text: line.text, ...(oldNo === undefined ? {} : { oldNo }), ...(line.newNo === undefined ? {} : { newNo: line.newNo }) })
        })
      } else {
        rows.push(...removed, ...added)
      }
      at = addedEnd
    }
    const added = rows.filter((row) => row.kind === 'added').length
    const removed = rows.filter((row) => row.kind === 'removed').length
    const unchanged = added + removed === 0 && file.status === 'edited' && !file.truncated && !file.binary && file.rows.length > 0
    if (unchanged) {
      hidden += 1
      continue
    }
    kept.push(rows.length === file.rows.length && added === file.added && removed === file.removed ? file : { ...file, rows, added, removed })
  }
  return { files: kept, hidden }
}

/** One row of the split view: the old side on the left, the new on the right. */
export type SplitRow =
  | { kind: 'gap'; count?: number }
  | { kind: 'pair'; left?: Exclude<DiffViewRow, { kind: 'gap' | 'added' }>; right?: Exclude<DiffViewRow, { kind: 'gap' | 'removed' }> }

/** Pairs a removed run with the added run after it, line by line; unchanged lines sit on both sides. */
export function splitRows(rows: readonly DiffViewRow[]): SplitRow[] {
  const out: SplitRow[] = []
  for (let at = 0; at < rows.length;) {
    const row = rows[at]!
    if (row.kind === 'gap') {
      out.push(row)
      at += 1
    } else if (row.kind === 'same') {
      out.push({ kind: 'pair', left: row, right: row })
      at += 1
    } else {
      const removed: Extract<DiffViewRow, { kind: 'removed' }>[] = []
      const added: Extract<DiffViewRow, { kind: 'added' }>[] = []
      while (rows[at]?.kind === 'removed') removed.push(rows[at++] as Extract<DiffViewRow, { kind: 'removed' }>)
      while (rows[at]?.kind === 'added') added.push(rows[at++] as Extract<DiffViewRow, { kind: 'added' }>)
      for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
        const left = removed[index]
        const right = added[index]
        out.push({ kind: 'pair', ...(left === undefined ? {} : { left }), ...(right === undefined ? {} : { right }) })
      }
    }
  }
  return out
}

/** The file's name and the folder it sits in, for a header that leads with the name. */
export function splitPath(path: string): { name: string; folder: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path, folder: '' } : { name: path.slice(at + 1), folder: path.slice(0, at) }
}

/** One run of changed lines in a file: where it starts among the rows, how long it is, and what it does. */
export interface ChangeRun {
  start: number
  length: number
  tone: 'added' | 'removed' | 'both'
}

/** The file's changes as runs, the unit the change markers along the pane's edge draw. */
export function changeRuns(rows: readonly DiffViewRow[]): ChangeRun[] {
  const runs: ChangeRun[] = []
  let open: ChangeRun | undefined
  rows.forEach((row, index) => {
    if (row.kind !== 'added' && row.kind !== 'removed') {
      open = undefined
      return
    }
    if (open === undefined) {
      open = { start: index, length: 0, tone: row.kind }
      runs.push(open)
    } else if (open.tone !== row.kind) open.tone = 'both'
    open.length += 1
  })
  return runs
}
