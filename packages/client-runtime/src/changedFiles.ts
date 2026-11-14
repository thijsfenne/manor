import type { FileEdit } from '@manor/contracts'
import { editStat } from './diff'
import { isToolStep, landed, type TurnRow } from './transcriptState'

/**
 * What a finished turn changed, per file rather than per hunk.
 *
 * A turn edits the same file four times and says nothing about it in between; the
 * trace above keeps every one of those calls in the order it happened, and this is
 * the other question — what is different now that it is over. One row per file, its
 * counts summed, and where possible the path the files panel can open.
 */
export interface ChangedFile {
  /** As the card shows it: repo-relative wherever Manor could place the file. */
  path: string
  /** Exactly what the driver reported, which is what a tooltip should say. */
  raw: string
  /** What the files panel opens. Absent for a file it cannot show. */
  panelPath?: string
  added: number
  removed: number
  status: 'created' | 'deleted' | 'edited'
  /** Every hunk the turn wrote into this file, in order, for the row's own diff. */
  edits: FileEdit[]
  /** Snapshot or hunk limits omitted part of this file's diff. */
  diffTruncated?: boolean
}

/**
 * Collapses a turn's edits into one row per file, in the order the turn first
 * touched them. The status follows `editVerb`'s reading of the same fields, so the
 * card and the diff rows below it never disagree about what happened to a file.
 */
export function changedFiles(edits: readonly FileEdit[], listing?: readonly string[]): ChangedFile[] {
  const index = listing === undefined ? undefined : indexListing(listing)
  const rows = new Map<string, ChangedFile>()

  for (const edit of edits) {
    const stat = editStat(edit)
    const origin = normalizedAbsolute(edit.originPath ?? edit.path)
    const panelPath = edit.panelPath !== undefined
      ? index?.listed.has(edit.panelPath) ? edit.panelPath : undefined
      : origin === undefined && index !== undefined ? resolve(edit.path, index) : undefined
    // Keyed on where the file actually is, not on how it was reported: two spellings
    // of one path would otherwise be two rows in the header's count and one row in
    // the tree, which shares their key.
    const key = panelPath ?? origin ?? edit.path
    const existing = rows.get(key)
    if (existing !== undefined) {
      existing.added += stat.added
      existing.removed += stat.removed
      existing.edits.push(edit)
      // The last word on the file wins, except for creation: a file made and then
      // edited in the same turn is still new to the reader.
      if (existing.status !== 'created') existing.status = statusOf(edit)
      else if (statusOf(edit) === 'deleted') existing.status = 'deleted'
      continue
    }
    rows.set(key, {
      path: edit.panelPath !== undefined
        ? index === undefined ? edit.panelPath : display(edit.panelPath, index)
        : index !== undefined && panelPath !== undefined ? display(panelPath, index) : origin ?? edit.path,
      raw: origin ?? edit.path,
      ...(panelPath === undefined ? {} : { panelPath }),
      added: stat.added,
      removed: stat.removed,
      status: statusOf(edit),
      edits: [edit],
    })
  }

  return [...rows.values()]
}

/**
 * Measured checkout changes replace tool reports; identifiable writes elsewhere remain
 * visible. Memory files are left out: the server names them in `memoryChanges`, and
 * the footer shows them there, so a turn that only logged has no changed files.
 */
export function turnChangedFiles(turn: TurnRow, listing?: readonly string[]): ChangedFile[] {
  const files = reportedChangedFiles(turn, listing)
  // A cut memory diff keeps its file here too: the footer card cannot show all of it.
  const memory = new Set((turn.memoryChanges ?? []).filter((change) => change.truncated !== true).map((change) => change.path))
  return memory.size === 0 ? files : files.filter((file) => !memory.has(file.raw))
}

function reportedChangedFiles(turn: TurnRow, listing?: readonly string[]): ChangedFile[] {
  const edits = turn.activities.flatMap((step) => (isToolStep(step) && landed(step) ? step.edits ?? [] : []))
  if (turn.fileChanges === undefined || turn.fileChangeRoots === undefined) return changedFiles(edits, listing)

  const roots = turn.fileChangeRoots.map((root) => root.replace(/\/$/, ''))
  const rootNames = roots.map((root) => root.split('/').at(-1) ?? root)
  const index = listing === undefined ? undefined : indexListing(listing)
  const measured = turn.fileChanges.map((change): ChangedFile => {
    const root = roots.find((candidate) => change.path.startsWith(`${candidate}/`))
    const relative = root === undefined ? change.path : change.path.slice(root.length + 1)
    const panelPath = change.panelPath !== undefined && index?.listed.has(change.panelPath)
      ? change.panelPath : undefined
    const rootName = root === undefined ? undefined : rootNames[roots.indexOf(root)]
    const label = rootName === undefined ? undefined : rootNames.filter((name) => name === rootName).length === 1
      ? rootName : root?.split('/').slice(-2).join('/')
    return {
      path: change.panelPath !== undefined
        ? index === undefined ? change.panelPath : display(change.panelPath, index)
        : label !== undefined && roots.length > 1 ? `${label}/${relative}` : relative,
      raw: change.path,
      ...(panelPath === undefined ? {} : { panelPath }),
      added: change.added,
      removed: change.removed,
      status: change.status,
      edits: change.edits,
      ...(change.diffTruncated ? { diffTruncated: true } : {}),
    }
  })
  const unmeasured = new Set(turn.fileChangeUnmeasured ?? [])
  const outside = edits.filter((edit) => {
    if (unmeasured.has(edit.originPath ?? edit.path)) return true
    const origin = normalizedAbsolute(edit.originPath ?? edit.path)
    return origin !== undefined && !roots.some((root) => origin.startsWith(`${root}/`))
  })
  return [...measured, ...changedFiles(outside, listing)]
}

function normalizedAbsolute(value: string): string | undefined {
  if (!value.startsWith('/')) return undefined
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

/**
 * The phone's conversation pill keeps one row per file across finished turns. A file
 * the conversation first saw created and a later turn deleted is back where it
 * started, so it leaves.
 */
export function chatChangedFiles(turns: readonly TurnRow[], listing?: readonly string[]): ChangedFile[] {
  const rows = new Map<string, ChangedFile>()
  const madeHere = new Set<string>()
  for (const turn of turns) {
    for (const file of turnChangedFiles(turn, listing)) {
      const key = file.panelPath ?? file.raw
      const existing = rows.get(key)
      if (existing === undefined) {
        if (file.status === 'deleted' && madeHere.has(key)) continue
        if (file.status === 'created') madeHere.add(key)
        rows.set(key, { ...file, edits: [...file.edits] })
        continue
      }
      if (file.status === 'deleted' && madeHere.has(key)) {
        rows.delete(key)
        continue
      }
      existing.added += file.added
      existing.removed += file.removed
      existing.edits.push(...file.edits)
      existing.diffTruncated ||= file.diffTruncated
      if (existing.status !== 'created') existing.status = file.status
      else if (file.status === 'deleted') existing.status = 'deleted'
    }
  }
  return [...rows.values()]
}

function statusOf(edit: FileEdit): ChangedFile['status'] {
  if (edit.kind === 'add' || edit.created === true) return 'created'
  if (edit.kind === 'delete' || (edit.kind === undefined && edit.after === undefined)) return 'deleted'
  return 'edited'
}

export function changedTotals(files: readonly ChangedFile[]): { added: number; removed: number } {
  return files.reduce(
    (total, file) => ({ added: total.added + file.added, removed: total.removed + file.removed }),
    { added: 0, removed: 0 },
  )
}

/**
 * The closed card's one line of shape: which top folders were touched and how much
 * of each. It answers "where did this land" without unfolding anything, which is the
 * question a reader who trusts the turn actually has.
 */
export function changedGroups(files: readonly ChangedFile[], limit = 4): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    // A file with no folder above it is not in a group of its own name; it is at
    // the root, and saying so beats naming it twice.
    const name = segments.length > 1 ? (segments[0] as string) : 'root'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const groups = [...counts].map(([name, count]) => ({ name, count }))
  groups.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'en'))
  if (groups.length <= limit) return groups
  const rest = groups.slice(limit).reduce((total, group) => total + group.count, 0)
  return [...groups.slice(0, limit), { name: '…', count: rest }]
}

export interface ChangedNode {
  /** The row's label. A folder that only holds another folder wears both names. */
  name: string
  /** The display path this node stands for, unique inside one card. */
  key: string
  added: number
  removed: number
  /** Set on leaves only. */
  file?: ChangedFile
  children: ChangedNode[]
}

/**
 * The files as a tree, with runs of single-child folders folded into one row.
 *
 * `apps` holding only `web` holding only `src` is three rows that say one thing, and
 * in a chat transcript the indentation costs more than the structure buys. Folder
 * counts are summed from the leaves, so a folded row still states what it holds.
 */
export function changedTree(files: readonly ChangedFile[]): ChangedNode[] {
  const root: ChangedNode = { name: '', key: '', added: 0, removed: 0, children: [] }

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    let parent = root
    segments.forEach((name, index) => {
      const leaf = index === segments.length - 1
      const key = segments.slice(0, index + 1).join('/')
      let node = parent.children.find((candidate) => candidate.key === key && (candidate.file !== undefined) === leaf)
      if (node === undefined) {
        node = { name, key, added: 0, removed: 0, children: [], ...(leaf ? { file } : {}) }
        parent.children.push(node)
      }
      node.added += file.added
      node.removed += file.removed
      parent = node
    })
  }

  fold(root)
  sort(root)
  return root.children
}

function fold(node: ChangedNode) {
  for (const child of node.children) fold(child)
  node.children = node.children.map((child) => {
    let folded = child
    while (folded.file === undefined && folded.children.length === 1) {
      const only = folded.children[0] as ChangedNode
      if (only.file !== undefined) break
      folded = { ...only, name: `${folded.name}/${only.name}` }
    }
    return folded
  })
}

function sort(node: ChangedNode) {
  node.children.sort(
    (left, right) =>
      Number(left.file !== undefined) - Number(right.file !== undefined) ||
      left.name.localeCompare(right.name, 'en'),
  )
  for (const child of node.children) sort(child)
}

/**
 * Every path a linked folder offers, keyed by the suffixes it can be recognised by.
 *
 * Drivers report what their provider gave them: Claude Code sends an absolute path,
 * Codex sends one relative to the folder it ran in, and the files panel knows
 * neither — it lists `<folder-label>/<path>`. Rather than rebuild the server's
 * labelling rules here, a reported path is matched against the listing itself, from
 * its longest suffix down.
 */
interface ListingIndex {
  bySuffix: Map<string, string[]>
  /**
   * Every listed path, for an exact lookup. Kept with the index so it is built once per
   * listing: the phone asks for every turn of a chat on each streamed frame.
   */
  listed: Set<string>
  /** The one folder label to drop from a display path, when there is only one. */
  strip: string
}

const indexes = new WeakMap<readonly string[], ListingIndex>()

function indexListing(listing: readonly string[]): ListingIndex {
  const cached = indexes.get(listing)
  if (cached !== undefined) return cached

  const bySuffix = new Map<string, string[]>()
  const roots = new Set<string>()
  for (const entry of listing) {
    const segments = entry.split('/').filter(Boolean)
    if (segments[0] !== undefined) roots.add(segments[0])
    for (let start = 0; start < segments.length; start += 1) {
      const suffix = segments.slice(start).join('/')
      const found = bySuffix.get(suffix)
      if (found === undefined) bySuffix.set(suffix, [entry])
      else found.push(entry)
    }
  }

  // Only with a single linked folder is the label noise: with two, it is the one
  // thing telling `src/App.tsx` apart from the other `src/App.tsx`.
  const index: ListingIndex = { bySuffix, listed: new Set(listing), strip: roots.size === 1 ? `${[...roots][0] as string}/` : '' }
  indexes.set(listing, index)
  return index
}

/**
 * The listing entry a reported path names, or nothing when Manor cannot be sure.
 *
 * Longest suffix wins, and a bare filename only counts when the reported path is one
 * too — otherwise a write into `~/notes/memory/daily/2026-08-12.md` would "resolve"
 * against any repo file that happened to share its name. An ambiguous match resolves
 * to nothing at all: opening the wrong file is worse than opening none.
 */
function resolve(reported: string, index: ListingIndex): string | undefined {
  const segments = reported.split('/').filter(Boolean)
  for (let start = 0; start <= segments.length - 1; start += 1) {
    const suffix = segments.slice(start).join('/')
    if (segments.length - start === 1 && segments.length > 1) break
    const matches = index.bySuffix.get(suffix)
    if (matches === undefined) continue
    return matches.length === 1 ? (matches[0] as string) : undefined
  }
  return undefined
}

/**
 * The same question a link in a reply asks: which listed file, if any, does this
 * path name? One rule for both, because a filename written in prose and a filename
 * reported by a driver are recognised the same way, and two rules would disagree
 * about the interesting cases first.
 */
export function resolveRepoPath(reported: string, listing?: readonly string[]): string | undefined {
  if (listing === undefined || reported === '') return undefined
  return resolve(reported, indexListing(listing))
}

/**
 * The repo-shaped part of a Markdown destination. Agents cite files the way their
 * tools print them, so anchors, queries and a trailing `:line[:column]` are metadata
 * rather than part of the path. A URL is deliberately not a repo candidate.
 */
function markdownRepoPath(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) return ''
  const withoutFragment = href.split(/[#?]/)[0] ?? ''
  const withoutLine = withoutFragment.replace(/:\d+(:\d+)?$/, '')
  return decodePath(withoutLine.replace(/^\.\//, ''))
}

/**
 * The name the writer meant. A Markdown destination cannot hold a raw space, so
 * `BRIEFING NOTES.md` reaches a reader as `BRIEFING%20NOTES.md` and the listing it
 * has to match never is. Decoded last, after the anchor and the `:line` are off, so
 * an encoded `#` or `:` in a filename survives being read as metadata. A lone `%` is
 * somebody's filename rather than a broken escape, and stays exactly as written.
 */
function decodePath(path: string): string {
  if (!path.includes('%')) return path
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/** The file in a chat's current listing named by a Markdown destination, if one is unambiguous. */
export function resolveMarkdownRepoLink(href: string, listing?: readonly string[]): string | undefined {
  return resolveRepoPath(markdownRepoPath(href), listing)
}

function display(panelPath: string, index: ListingIndex): string {
  return index.strip !== '' && panelPath.startsWith(index.strip) ? panelPath.slice(index.strip.length) : panelPath
}

/**
 * A line count small enough to sit in a pill. Under a thousand it is the number
 * itself, because "+912" is as short as any abbreviation and exact; past that the
 * magnitude is the answer and the last two digits are noise nobody reads off a
 * floating badge. Dutch decimal comma, since that is the language the phone speaks.
 */
export function compactCount(total: number): string {
  if (total < 1000) return String(total)
  if (total < 1_000_000) {
    const thousands = total / 1000
    return `${thousands.toFixed(thousands < 10 ? 1 : 0).replace('.', ',').replace(',0', '')}K`
  }
  const millions = total / 1_000_000
  return `${millions.toFixed(millions < 10 ? 1 : 0).replace('.', ',').replace(',0', '')}M`
}
