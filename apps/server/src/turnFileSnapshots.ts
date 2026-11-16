import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, lstat, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EDIT_SIDE_LIMIT, MAX_EDITS_PER_CALL, type FileEdit, type TurnFileChange } from '@manor/contracts'
import { hunkOffset } from './drivers/edits.js'
import { isPreviewablePath, sensitiveGitPathspecExcludes } from './repoFiles.js'
import { gitBinary } from './gitBinary.js'

const run = promisify(execFile)
const { GIT_DIR: _gitDir, GIT_WORK_TREE: _gitWorkTree, GIT_INDEX_FILE: _gitIndex, ...gitEnv } = process.env

async function git(cwd: string, args: string[], index?: string, maxBuffer = 8_000_000): Promise<string> {
  const { stdout } = await run(gitBinary(), args, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    env: { ...gitEnv, ...(index === undefined ? {} : { GIT_INDEX_FILE: index }) },
  })
  return stdout
}

/** Files a folder without git may hold before a walk stops measuring it. */
export const MAX_WALKED_FILES = 20_000
/** `.review` is a reviewer's probe scratch, never Session work; see `isReviewScratch`. */
const UNWALKED = new Set(['.git', 'node_modules', '.review'])

/** Gone between listing and reading: the next walk reports it removed, nothing was missed. */
const vanished = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * A folder git cannot snapshot, as each file's inode, size, modification and change
 * time: enough to tell which files a turn touched, never what changed in them. The
 * change time moves on every write and no tool can set it, so a rewrite that keeps the
 * size and restores the modification time still shows. Undefined when the walk is
 * incomplete (a folder or file it cannot read) or past `MAX_WALKED_FILES`.
 */
export async function captureFolderStats(root: string): Promise<Map<string, string> | undefined> {
  const stats = new Map<string, string>()
  const queue = ['']
  let incomplete = false
  const unreadable = (error: unknown) => {
    if (!vanished(error)) incomplete = true
    return undefined
  }
  while (queue.length > 0) {
    const relative = queue.shift() as string
    const children = await readdir(path.join(root, relative), { withFileTypes: true })
      .catch((error: unknown) => relative === '' ? (incomplete = true, undefined) : unreadable(error))
    if (incomplete) return undefined
    if (children === undefined) continue
    const files: string[] = []
    for (const child of children) {
      if (UNWALKED.has(child.name)) continue
      const childPath = relative === '' ? child.name : `${relative}/${child.name}`
      if (child.isDirectory()) queue.push(childPath)
      else if (child.isFile()) files.push(childPath)
    }
    if (stats.size + files.length > MAX_WALKED_FILES) return undefined
    await Promise.all(files.map(async (file) => {
      const info = await lstat(path.join(root, file)).catch(unreadable)
      if (info !== undefined) stats.set(file, `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
    }))
    if (incomplete) return undefined
  }
  return stats
}

/** The files added, removed or rewritten between two walks of one folder. */
export const changedFolderFiles = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] => [
  ...[...after].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => file),
  ...[...before.keys()].filter((file) => !after.has(file)),
]

/**
 * Ignored working notes the snapshot still captures, because Files shows them.
 * Files also shows the verification evidence folders, but those stay uncaptured on
 * purpose: screenshots are proof of a change, not Session work, and counting them
 * would turn every verify run into a change that voids Argus's pass.
 */
const CAPTURED_IGNORED = ['.claude/ideas', '.claude/plans']

/**
 * An ignored `.review/` folder holds a reviewer's probe tests, which prove a finding
 * without editing tracked files. They are scratch, not Session work: counting them
 * would void the pass Argus records in the same turn.
 */
const isReviewScratch = (file: string): boolean => file.split('/').includes('.review')

/**
 * The repo-relative paths a captured tree cannot hold: ignored by Git and outside
 * the captured working notes and review scratch. Hidden credentials stay out, as they do from the tree.
 */
export async function unmeasuredPaths(cwd: string, relatives: readonly string[]): Promise<Set<string>> {
  const candidates = relatives.filter((file) => isPreviewablePath(file) && !isReviewScratch(file) &&
    !CAPTURED_IGNORED.some((folder) => file.startsWith(`${folder}/`)))
  const ignored = new Set<string>()
  for (let start = 0; start < candidates.length; start += 100) {
    const batch = candidates.slice(start, start + 100)
    // Exit status 1 means none of the batch is ignored.
    const output = await git(cwd, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...batch]).catch(() => '')
    for (const file of output.split('\n')) if (file.length > 0) ignored.add(file)
  }
  return ignored
}

const PATH_CHAR = /[A-Za-z0-9_.\-/]/

/** `needle` as a whole path in `text`: not the tail of a longer path, not a prefix of a longer name. */
function mentionsPath(text: string, needle: string, asFolder: boolean): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = text[at - 1]
    const after = text[at + needle.length]
    // `./src/a.ts` is still `src/a.ts`; a folder may sit at the end of an absolute `cd`.
    const startsHere = before === undefined || !PATH_CHAR.test(before) ||
      (before === '/' && (asFolder || (text[at - 2] === '.' && !PATH_CHAR.test(text[at - 3] ?? ' '))))
    // A dot that continues the name (`a.ts.bak`) is a longer name; one ending a sentence is not.
    const endsHere = after === undefined || !/[A-Za-z0-9_\-]/.test(after) &&
      !(after === '.' && /[A-Za-z0-9_\-]/.test(text[at + needle.length + 1] ?? '')) && (asFolder || after !== '/')
    if (startsHere && endsHere) return true
  }
  return false
}

/**
 * Whether a turn's own tool calls named this file, the only attribution a shared
 * working copy allows. A file counts when a call gives its path from the repo root,
 * or gives the rest of it after the turn named the folders above it, the way a
 * `cd apps/web` followed by `sed -i … src/Button.tsx` does. A same-named file in
 * another folder does not count.
 */
export function namesFile(texts: readonly string[], root: string, relative: string): boolean {
  if (texts.some((text) => mentionsPath(text, `${root}/${relative}`, false))) return true
  const segments = relative.split('/')
  return segments.some((_, split) => {
    const rest = segments.slice(split).join('/')
    const folder = segments.slice(0, split).join('/')
    return texts.some((text) => mentionsPath(text, rest, false)) &&
      (split === 0 || texts.some((text) => mentionsPath(text, folder, true)))
  })
}

/**
 * Starts the temporary index as HEAD but with the real index's stat cache, so
 * `add -A` rehashes only files that changed instead of the whole worktree. The
 * copy keeps the real index's mtime, which git's racy-clean check compares against.
 * A real index with assume-unchanged or skip-worktree entries falls back to HEAD.
 */
async function seedFromRealIndex(cwd: string, index: string): Promise<boolean> {
  try {
    const real = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
    const { atime, mtime } = await stat(real)
    await copyFile(real, index)
    await utimes(index, atime, mtime)
    await git(cwd, ['read-tree', '-m', 'HEAD'], index)
    // assume-unchanged and skip-worktree entries would hide edits from `add -A`.
    const flagged = (await git(cwd, ['ls-files', '-v', '-z'], index)).split('\0')
      .some((entry) => /^[a-zS]/.test(entry))
    if (!flagged) return true
  } catch {
    // Any failure falls back to the plain HEAD index below.
  }
  await rm(index, { force: true })
  return false
}

/** Capture the worktree without touching its real index or branch. */
export async function captureTurnTree(cwd: string): Promise<string> {
  const temp = await mkdtemp(path.join(tmpdir(), 'manor-turn-index-'))
  const index = path.join(temp, 'index')
  try {
    if (!await seedFromRealIndex(cwd, index)) {
      try {
        await git(cwd, ['read-tree', 'HEAD'], index)
      } catch {
        await git(cwd, ['read-tree', '--empty'], index)
      }
    }
    await git(cwd, ['add', '-A', '--', '.', ...sensitiveGitPathspecExcludes()], index)
    const ignored = (await git(cwd, [
      'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...CAPTURED_IGNORED,
    ], index)).split('\0').filter((file) => file.length > 0 && isPreviewablePath(file))
    if (ignored.length > 0) {
      const pathspecs = path.join(temp, 'ignored')
      await writeFile(pathspecs, ignored.map((file) => `:(literal)${file}`).join('\0'))
      await git(cwd, ['add', '-f', `--pathspec-from-file=${pathspecs}`, '--pathspec-file-nul'], index)
    }
    return (await git(cwd, ['write-tree'], index)).trim()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

function parseHunks(patch: string, filePath: string): { edits: FileEdit[]; truncated: boolean } {
  const edits: FileEdit[] = []
  let before: string[] = []
  let after: string[] = []
  let inHunk = false
  let truncated = false
  let offset: FileEdit['offset']
  const flush = () => {
    if (!inHunk) return
    const left = before.join('\n')
    const right = after.join('\n')
    if (edits.length < MAX_EDITS_PER_CALL) {
      const over = left.length > EDIT_SIDE_LIMIT || right.length > EDIT_SIDE_LIMIT
      edits.push({
        path: filePath.slice(0, 400),
        before: left.slice(0, EDIT_SIDE_LIMIT),
        after: right.slice(0, EDIT_SIDE_LIMIT),
        ...(offset === undefined ? {} : { offset }),
        ...(over ? { truncated: true } : {}),
      })
      truncated ||= over
    } else {
      truncated = true
    }
    before = []
    after = []
  }
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) {
      flush()
      inHunk = true
      offset = hunkOffset(line)
    } else if (inHunk && line.startsWith('+')) {
      after.push(line.slice(1))
    } else if (inHunk && line.startsWith('-')) {
      before.push(line.slice(1))
    } else if (inHunk && line.startsWith(' ')) {
      before.push(line.slice(1))
      after.push(line.slice(1))
    }
  }
  flush()
  return { edits, truncated }
}

/** Git's NUL format leaves a blank path before the two rename paths. */
export function parseNumstat(output: string): { path: string; oldPath?: string; added: number; removed: number }[] {
  const fields = output.split('\0')
  const files: { path: string; oldPath?: string; added: number; removed: number }[] = []
  for (let i = 0; i < fields.length - 1; i += 1) {
    const record = fields[i] as string
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const added = Number(record.slice(0, first)) || 0
    const removed = Number(record.slice(first + 1, second)) || 0
    const name = record.slice(second + 1)
    if (name.length > 0) files.push({ path: name, added, removed })
    else {
      const oldPath = fields[++i] as string
      const newPath = fields[++i] as string
      files.push({ path: newPath, oldPath, added, removed })
    }
  }
  return files
}

export function parseStatuses(output: string): Map<string, TurnFileChange['status']> {
  const parts = output.split('\0')
  const statuses = new Map<string, TurnFileChange['status']>()
  for (let i = 0; i < parts.length - 1; i += 1) {
    const code = parts[i] as string
    const oldOrCurrent = parts[++i] as string
    const filePath = code.startsWith('R') || code.startsWith('C') ? (parts[++i] as string) : oldOrCurrent
    statuses.set(filePath, code === 'A' ? 'created' : code === 'D' ? 'deleted' : 'edited')
  }
  return statuses
}

/** `keep` narrows the result to files the caller can attribute, by repo-relative path. */
export async function diffTurnTrees(
  cwd: string,
  before: string,
  after: string,
  keep?: (relative: string) => boolean,
): Promise<TurnFileChange[]> {
  if (before === after) return []
  const base = ['diff', '--no-ext-diff', '--no-color', '--find-renames', before, after]
  const [stats, names] = await Promise.all([
    git(cwd, [...base, '--numstat', '-z']),
    git(cwd, [...base, '--name-status', '-z']),
  ])
  const statuses = parseStatuses(names)
  const files = parseNumstat(stats).filter((file) => isPreviewablePath(file.path) &&
    (keep === undefined || keep(file.path) || (file.oldPath !== undefined && keep(file.oldPath))))
  if (files.length > 500) throw new Error('Turn changed more than 500 files')
  if (files.some((file) => path.join(cwd, file.path).length > 1_024)) {
    throw new Error('Turn contains a path longer than the transcript limit')
  }
  // Smallest files first, so a wide turn spends its budget on many readable diffs
  // and only its largest files go without hunks. A batch's results are counted in
  // that order, so the budget overshoots by at most one file's capped hunks.
  const order = [...files.keys()].sort((left, right) => lineCount(files[left]) - lineCount(files[right]))
  const parsed = new Map<number, ReturnType<typeof parseHunks>>()
  let spent = 0
  for (let start = 0; start < order.length && spent < TURN_DIFF_BUDGET; start += PATCH_BATCH) {
    const batch = order.slice(start, start + PATCH_BATCH).flatMap((index) => {
      const file = files[index]
      return file === undefined ? [] : [{ index, file }]
    })
    const patches = await Promise.all(batch.map(({ file }) =>
      git(cwd, [...base, '--unified=2', '--', ...(file.oldPath ? [file.oldPath] : []), file.path], undefined, 1_000_000)
        .catch(() => null)))
    batch.forEach(({ index, file }, at) => {
      if (spent >= TURN_DIFF_BUDGET) return
      const patch = patches[at] ?? null
      const result = patch === null ? { edits: [], truncated: true } : parseHunks(patch, file.path)
      spent += result.edits.reduce((sum, edit) => sum + (edit.before?.length ?? 0) + (edit.after?.length ?? 0), 0)
      parsed.set(index, result)
    })
  }
  return files.map((file, index) => {
    const result = parsed.get(index)
    return {
      path: path.join(cwd, file.path),
      ...(file.oldPath === undefined ? {} : { oldPath: path.join(cwd, file.oldPath) }),
      status: statuses.get(file.path) ?? 'edited',
      added: file.added,
      removed: file.removed,
      edits: result?.edits ?? [],
      ...(result === undefined ? { diffSkipped: true } : result.truncated ? { diffTruncated: true } : {}),
    }
  })
}

/**
 * Characters of hunk text one turn's measured diff may store per checkout. The
 * transcript is read back whole on every chat open; per file, the contract caps
 * already hold a diff to `MAX_EDITS_PER_CALL` hunks of `EDIT_SIDE_LIMIT` a side.
 */
export const TURN_DIFF_BUDGET = 1_000_000
/** Patches git computes at once. */
const PATCH_BATCH = 16

const lineCount = (file: { added: number; removed: number } | undefined) => (file?.added ?? 0) + (file?.removed ?? 0)
