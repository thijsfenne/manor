import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ThreadEvent, WorkCompletion, WorkHandoff } from '@manor/contracts'
import type { ChatWorktree } from './store.js'
import { captureTurnTree } from './turnFileSnapshots.js'
import { gitBinary } from './gitBinary.js'

const run = promisify(execFile)
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run(gitBinary(), args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 2_000_000 })
  return stdout.trim()
}
/** File contents byte for byte (latin1 maps each byte to one character), with the exit code `merge-file` answers in. */
async function gitBytes(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run(gitBinary(), args, { cwd, env: gitEnv(), encoding: 'latin1', maxBuffer: 64_000_000 })
    return { code: 0, out: stdout }
  } catch (error: unknown) {
    const failed = error as { code?: unknown; stdout?: unknown }
    if (typeof failed.code === 'number' && typeof failed.stdout === 'string') return { code: failed.code, out: failed.stdout }
    throw error
  }
}

/** Git reports resolved roots (macOS `/var` is `/private/var`); a deleted folder resolves through its parent. */
async function resolved(folder: string): Promise<string> {
  const rest: string[] = []
  for (let at = folder; ; at = path.dirname(at)) {
    const real = await realpath(at).catch(() => undefined)
    if (real !== undefined) return path.join(real, ...rest.reverse())
    if (path.dirname(at) === at) return folder
    rest.push(path.basename(at))
  }
}

/** The entry Git tracks: a symlink is its own file, never the target it points at. */
export async function resolvedEntry(file: string): Promise<string> {
  return path.join(await resolved(path.dirname(file)), path.basename(file))
}

/** Captures the approval without changing the real index, branch or checkout. */
export async function prepareWorkCompletion(
  roots: readonly string[], files: readonly string[], worktrees: readonly ChatWorktree[], mergeInto?: string,
): Promise<WorkCompletion> {
  const repos: WorkCompletion['repos'] = []
  // Unmeasured relative names are Git-ignored by construction, so they never reach a commit.
  const measured = await Promise.all(files.filter((file) => path.isAbsolute(file)).map(resolvedEntry))
  const mappings = await Promise.all(worktrees.map(async (row) => ({ ...row, real: await resolved(row.worktreePath) })))
  const gitPaths = [...new Set((await Promise.all(roots.map((root) =>
    git(root, ['rev-parse', '--show-toplevel']).catch(() => undefined),
  ))).filter((root): root is string => root !== undefined))]
  for (const root of gitPaths) {
    let relative = [...new Set(measured.flatMap((file) => {
      const name = path.relative(root, file)
      return name.length > 0 && name !== '..' && !name.startsWith(`..${path.sep}`) && !path.isAbsolute(name) ? [name] : []
    }))]
    if (relative.length === 0) continue
    const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const before = await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')
    const tree = await captureTurnTree(root)
    const paths = relative.map((file) => `:(literal)${file}`)
    const tracked = before === '' ? '' : await git(root, ['ls-tree', '-r', '--name-only', '-z', before, '--', ...paths])
    const committable = new Set((tracked + '\0' + await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...paths])).split('\0'))
    // Without --no-renames a moved file lists only its new path, and the old one stays behind on the branch.
    const changed = new Set(before === '' ? relative : (await git(root, ['diff', '--no-renames', '--name-only', '-z', before, tree, '--', ...paths])).split('\0'))
    relative = relative.filter((file) => committable.has(file) && changed.has(file))
    if (relative.length === 0) continue
    const mapping = mappings.find((row) => row.real === root)
    // sourcePath marks a Session-owned worktree; without it the checkout is shared with other chats.
    repos.push({ path: root, branch, before, tree, files: relative,
      ...(mapping === undefined ? {} : {
        sourcePath: mapping.sourcePath, sourceHead: await git(mapping.sourcePath, ['rev-parse', 'HEAD']),
        ...(mergeInto === undefined ? {} : { mergeInto }),
      }),
    })
  }
  return { status: repos.length === 0 ? 'complete' : 'pending',
    operation: repos.length === 0 ? 'none' : mergeInto === undefined ? 'commit' : 'merge', repos,
    ...(repos.length === 0 ? { completedAt: Date.now() } : {}),
  }
}

type StartBranches = NonNullable<WorkHandoff['startBranches']>

/** The branch each repo under these roots is on, read at Accept. A detached HEAD has none to keep. */
export async function checkoutBranches(roots: readonly string[]): Promise<StartBranches> {
  const read = await Promise.all(roots.map(async (root) => {
    const top = await git(root, ['rev-parse', '--show-toplevel']).catch(() => undefined)
    const branch = top === undefined ? undefined : await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => undefined)
    return top === undefined || branch === undefined || branch === '' ? [] : [{ path: top, branch }]
  }))
  return [...new Map(read.flat().map((row) => [row.path, row])).values()]
}

/**
 * Why a shared-checkout result may not be committed: a repo it changed is no longer on
 * the branch the Session started on, so the commit would land on whatever the checkout
 * switched to. Undefined when every changed repo is where it began.
 */
export function leftStartBranch(start: StartBranches | undefined, repos: readonly { path: string; branch: string; sourcePath?: string }[]): string | undefined {
  for (const repo of repos) {
    if (repo.sourcePath !== undefined) continue
    const expected = start?.find((row) => row.path === repo.path)?.branch
    if (expected === undefined || expected === repo.branch) continue
    return `This Session started on ${expected}, but Manor found ${path.basename(repo.path)} on ${repo.branch}. Switch it back to ${expected} so the commit lands there.`
  }
  return undefined
}

/**
 * An intervening write needs another result and review, not a silent change to the
 * approval. In the shared checkout the approval may only narrow, by files HEAD now holds
 * exactly as published: another Session committed them. A worktree approval never narrows.
 */
export async function assertSameWorkResult(ready: WorkCompletion, current: WorkCompletion): Promise<void> {
  if (current.repos.some((now) => !ready.repos.some((previous) => previous.path === now.path))) {
    throw new Error('The Session checkout changed. Use Request changes on the result to get an updated one.')
  }
  for (const previous of ready.repos) {
    const now = current.repos.find((repo) => repo.path === previous.path)
    if (now === undefined && previous.sourcePath !== undefined) throw new Error('The Session checkout changed. Use Request changes on the result to get an updated one.')
    // A repo whose every file landed drops out of `current`; read it live.
    const branch = now?.branch ?? await git(previous.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
    const head = now?.before ?? await git(previous.path, ['rev-parse', '--verify', 'HEAD']).catch(() => '')
    const tree = now?.tree ?? await captureTurnTree(previous.path).catch(() => '')
    const kept = now?.files ?? []
    const dropped = previous.files.filter((file) => !kept.includes(file))
    const same = (from: string, to: string, files: readonly string[]) => from !== '' && to !== '' &&
      git(previous.path, ['diff', '--quiet', from, to, '--', ...literals(files)]).then(() => true, () => false)
    if (branch !== previous.branch || kept.some((file) => !previous.files.includes(file)) ||
      (dropped.length > 0 && (previous.sourcePath !== undefined || !await same(head, previous.tree, dropped))) ||
      (previous.before !== '' && !await git(previous.path, ['merge-base', '--is-ancestor', previous.before, head]).then(() => true, () => false)) ||
      !await same(previous.tree, tree, previous.files)) {
      throw new Error('The files changed after the result was published. Use Request changes on the result to get an updated one before confirming.')
    }
  }
}

type ApprovedRepo = WorkCompletion['repos'][number]

/** A repo's HEAD commit, or '' on a branch with none yet. */
export const repoHead = (repo: string) => git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')

/**
 * Whether a repo still holds what Confirm approved, read right before Manor commits it:
 * the same branch, nothing rewound, and the approved files as published.
 */
export async function approvalHolds(repo: ApprovedRepo): Promise<boolean> {
  const branch = await git(repo.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
  const head = await repoHead(repo.path)
  if (branch !== repo.branch) return false
  if (repo.before !== '' && !await git(repo.path, ['merge-base', '--is-ancestor', repo.before, head]).then(() => true, () => false)) return false
  const tree = await captureTurnTree(repo.path).catch(() => '')
  return tree !== '' && await git(repo.path, ['diff', '--quiet', repo.tree, tree, '--', ...literals(repo.files)]).then(() => true, () => false)
}

/** NUL-separated paths exactly as Git wrote them: a name may start or end with a space. */
async function gitPaths(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await run(gitBinary(), args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 64_000_000 })
  return stdout.split('\0').filter(Boolean)
}

/**
 * What the Session's branch holds since `from` beyond the approval: a path outside it, or
 * an approved path whose content differs from the published result, as a pre-commit hook
 * that stages or rewrites files leaves it. Empty when the branch adds exactly the approval.
 */
export async function beyondApproval(repo: ApprovedRepo, from: string): Promise<string[]> {
  const tip = `refs/heads/${repo.branch}`
  const changed = await gitPaths(repo.path, ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', ...(from === '' ? ['--root', tip] : [from, tip])])
  const rewritten = await gitPaths(repo.path, ['diff', '--name-only', '-z', repo.tree, tip, '--', ...literals(repo.files)])
  return [...new Set([...changed.filter((file) => !repo.files.includes(file)), ...rewritten])]
}

/** The card's line for a branch that holds more than Confirm approved. */
export const beyondLine = (files: readonly string[]): string =>
  `The commit holds ${fileList(files)} beyond what Confirm approved. Request a new result in the Session.`

/** Takes Manor's own commit back off the branch, its changes left staged in the worktree. */
export async function undoCommit(repo: string, parent: string): Promise<void> {
  await git(repo, parent === '' ? ['update-ref', '-d', 'HEAD'] : ['reset', '--soft', parent])
}

/**
 * Each path's `ls-tree` entry in a tree or commit, its mode and object together; a path
 * it lacks is absent from the map. The mode counts: an approved executable bit is part
 * of the change.
 */
function parseEntries(listed: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const entry of listed.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t')
    const [mode, , object] = entry.slice(0, tab).split(' ')
    if (tab > 0 && object !== undefined) entries.set(entry.slice(tab + 1), `${mode} ${object}`)
  }
  return entries
}
const modeOf = (entry: string | undefined) => entry?.split(' ')[0]
const literals = (files: readonly string[]) => files.map((file) => `:(literal)${file}`)
const entriesAt = async (cwd: string, treeish: string, files: readonly string[]) =>
  parseEntries(await git(cwd, ['ls-tree', '-r', '-z', treeish, '--', ...literals(files)]))

/**
 * The lines a minimal line diff removes from `from` and adds to reach `to`, or undefined
 * when the region is too large to diff here.
 */
function lineDiff(from: readonly string[], to: readonly string[]): { removed: string[]; added: string[] } | undefined {
  let start = 0
  while (start < from.length && start < to.length && from[start] === to[start]) start++
  let end = 0
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++
  const [a, b] = [from.slice(start, from.length - end), to.slice(start, to.length - end)]
  if (a.length * b.length > 4_000_000) return undefined
  // Longest common subsequence lengths of every pair of suffixes.
  const width = b.length + 1
  const common = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!)
    }
  }
  const removed: string[] = []
  const added: string[] = []
  let [i, j] = [0, 0]
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) [i, j] = [i + 1, j + 1]
    else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) removed.push(a[i++]!)
    else added.push(b[j++]!)
  }
  return { removed: [...removed, ...a.slice(i)], added: [...added, ...b.slice(j)] }
}

/**
 * Whether `to` is `from` with edits of its own that leave the `changed` lines in place:
 * no edit removes or adds a line with that content, and none moves a line (removes and
 * re-adds the same content), so each changed line keeps its order among the lines that
 * stay. Undefined when the region is too large to tell.
 */
function editedAround(from: readonly string[], to: readonly string[], changed: ReadonlySet<string>): boolean | undefined {
  const diff = lineDiff(from, to)
  if (diff === undefined) return undefined
  const added = new Set(diff.added)
  return [...diff.removed, ...diff.added].every((line) => !changed.has(line)) && diff.removed.every((line) => !added.has(line))
}

/**
 * How the tip moved a region both it and the confirmation changed: the confirmation's
 * version with edits of its own around the change (carried), the version before with
 * edits of its own around it (absent), or some other way. Order counts, so a reordering
 * the tip undid or never made is not carried.
 */
function regionMoved(region: Record<'tip' | 'before' | 'confirmed', string[]>): 'carried' | 'absent' | 'other' {
  const change = lineDiff(region.before, region.confirmed)
  if (change === undefined) return 'other'
  const changed = new Set([...change.removed, ...change.added])
  const carried = editedAround(region.confirmed, region.tip, changed)
  const absent = editedAround(region.before, region.tip, changed)
  if (carried === undefined || absent === undefined || carried === absent) return 'other'
  return carried ? 'carried' : 'absent'
}

/**
 * Whether the tip's version of a file holds the change the confirmation made to it,
 * whatever else changed around it. Git merges the confirmation into the tip: where only
 * the confirmation touched a region, the tip must already match it. Where both did, the
 * tip must be the confirmed lines with edits of its own around them (`regionMoved`). A
 * region that is the earlier lines with edits around them is the change missing; one the
 * tip rewrote another way may be a later version or a
 * replacement, which Git cannot tell apart, so that stays unknown. So does a mode the
 * tip changed itself, and a file Git cannot merge as text.
 */
async function carriedChange(
  cwd: string, entries: { before?: string; confirmed?: string; tip?: string },
): Promise<'yes' | 'no' | 'unknown'> {
  const tipMode = modeOf(entries.tip)
  if (tipMode !== modeOf(entries.confirmed)) return tipMode === modeOf(entries.before) ? 'no' : 'unknown'
  const temp = await mkdtemp(path.join(tmpdir(), 'manor-completion-merge-'))
  try {
    const sides = ['tip', 'before', 'confirmed'] as const
    // An absent entry merges as an empty file, the way an added or deleted file reads.
    const [tip] = await Promise.all(sides.map(async (side) => {
      const object = entries[side]?.split(' ')[1]
      const blob = object === undefined ? { code: 0, out: '' } : await gitBytes(cwd, ['cat-file', 'blob', object])
      if (blob.code !== 0) throw new Error(`git cat-file exited ${blob.code}`)
      await writeFile(path.join(temp, side), blob.out, 'latin1')
      return blob.out
    }))
    const marker = randomUUID()
    const merge = (style: '--diff3' | '--ours') => gitBytes(temp, ['merge-file', '-p', style, '--marker-size=41',
      ...sides.flatMap((side) => ['-L', `${side} ${marker}`]), ...sides])
    const merged = await merge('--diff3')
    if (merged.code === 0) return merged.out === tip ? 'yes' : 'no'
    // A negative or high code is an error, a binary file for one, not a count of conflicts.
    if (merged.code < 0 || merged.code > 127) return 'unknown'
    // Conflicts settled for the tip leave only what the confirmation alone changed.
    if ((await merge('--ours')).out !== tip) return 'no'
    const moved: ReturnType<typeof regionMoved>[] = []
    let side: (typeof sides)[number] | undefined
    let region = { tip: [] as string[], before: [] as string[], confirmed: [] as string[] }
    for (const line of merged.out.split('\n')) {
      if (line === `${'<'.repeat(41)} tip ${marker}`) side = 'tip'
      else if (line === `${'|'.repeat(41)} before ${marker}`) side = 'before'
      else if (side === 'before' && line === '='.repeat(41)) side = 'confirmed'
      else if (line === `${'>'.repeat(41)} confirmed ${marker}`) {
        moved.push(regionMoved(region))
        side = undefined
        region = { tip: [], before: [], confirmed: [] }
      } else if (side !== undefined) region[side].push(line)
    }
    if (moved.includes('absent')) return 'no'
    return moved.length > 0 && moved.every((region) => region === 'carried') ? 'yes' : 'unknown'
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

const names = (listed: string) => listed.split('\0').filter(Boolean)

/** A branch's reflog, newest first; `time` is the entry's whole second, in milliseconds. */
async function branchReflog(cwd: string, branch: string): Promise<{ hash: string; time: number; subject: string }[]> {
  return (await git(cwd, ['reflog', 'show', '--date=unix', '--format=%H %gd %gs', `refs/heads/${branch}`, '--']).catch(() => ''))
    .split('\n').filter(Boolean).map((line) => {
      const [hash = '', selector = ''] = line.split(' ', 2)
      return { hash, time: Number(/@\{(\d+)\}$/.exec(selector)?.[1] ?? Number.NaN) * 1000, subject: line.slice(hash.length + selector.length + 2) }
    })
}

const REBASE_FINISH = /^(?:rebase|pull --rebase)\b.*\(finish\): \S+ onto ([0-9a-f]+)$/

/**
 * The commits a worktree Session made on its own branch, read from the branch's reflog:
 * each commit, and the commits a rebase (or pull --rebase) created, those that were not
 * already in the branch's history before it. A merge or fast-forward from main, a reset
 * and a cherry-pick bring in other chats' commits, so they make no one the author. An
 * expired reflog proves nothing, and the contents decide alone.
 */
async function sessionCommits(cwd: string, branch: string): Promise<Set<string>> {
  const own = new Set<string>()
  const entries = await branchReflog(cwd, branch)
  for (const [at, { hash, subject }] of entries.entries()) {
    if (/^commit(?: \((?:amend|initial)\))?: /.test(subject)) own.add(hash)
    const base = REBASE_FINISH.exec(subject)?.[1]
    // Without the branch's value before the rebase, what it created cannot be told apart.
    const before = entries[at + 1]?.hash
    if (base === undefined || before === undefined) continue
    for (const created of names(await git(cwd, ['rev-list', '-z', hash, '--not', base, before]))) own.add(created)
  }
  return own
}

const onBranch = async (cwd: string, branch: string, hash: string) =>
  git(cwd, ['merge-base', '--is-ancestor', hash, `refs/heads/${branch}`]).then(() => true, () => false)

/** Reflogs retain superseded amend/rebase versions; only current branch ancestors are deliverable. */
export async function currentSessionCommits(cwd: string, branch: string): Promise<Set<string>> {
  const current = new Set<string>()
  for (const hash of await sessionCommits(cwd, branch)) {
    if (await onBranch(cwd, branch, hash)) current.add(hash)
  }
  return current
}

/** Author, author time and subject: what a rebase carries over to each commit it replays, conflict or not. */
async function replayIdentities(cwd: string, hashes: readonly string[]): Promise<Map<string, string>> {
  if (hashes.length === 0) return new Map()
  const lines = (await git(cwd, ['log', '--no-walk=unsorted', '--format=%H%x1f%ae%x1f%at%x1f%s', ...hashes])).split('\n')
  return new Map(lines.filter(Boolean).map((line) => [line.slice(0, line.indexOf('\x1f')), line.slice(line.indexOf('\x1f') + 1)]))
}

/**
 * The commits on a worktree branch that its Session made since `since` (the worktree's
 * `createdAt`), which Confirm does not count as unreviewed. Stricter than `sessionCommits`
 * on rewrites: an amend is the Session's only when the tip it replaced was, and a commit a
 * rebase created is the Session's only when it replays one of the Session's commits, so a
 * commit the branch already carried, or one picked in from elsewhere, stays foreign. Reflog
 * times are whole seconds, so an entry in the second the worktree was created counts as
 * foreign; that second holds no turn yet, and a miss withholds the merge, never widens it.
 */
export async function ownCommitsSince(cwd: string, branch: string, since: number): Promise<Set<string>> {
  const own = new Set<string>()
  const entries = await branchReflog(cwd, branch)
  // Oldest first, so a rewrite can ask whether what it replaced was already the Session's.
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const { hash, time, subject } = entries[at]!
    if (!(time >= since)) continue
    const previous = entries[at + 1]?.hash
    const commit = /^commit(?: \((amend|initial)\))?: /.exec(subject)
    if (commit !== null) {
      if (commit[1] !== 'amend' || (previous !== undefined && own.has(previous))) own.add(hash)
      continue
    }
    const base = REBASE_FINISH.exec(subject)?.[1]
    if (base === undefined || previous === undefined) continue
    const replayed = names(await git(cwd, ['rev-list', '-z', previous, '--not', base])).filter((commit) => own.has(commit))
    const created = names(await git(cwd, ['rev-list', '-z', hash, '--not', base, previous]))
    const identities = await replayIdentities(cwd, [...replayed, ...created])
    const owned = new Set(replayed.map((commit) => identities.get(commit)))
    for (const commit of created) if (identities.has(commit) && owned.has(identities.get(commit))) own.add(commit)
  }
  const current = new Set<string>()
  for (const hash of own) {
    if (await onBranch(cwd, branch, hash)) current.add(hash)
  }
  return current
}

/** Ancestry proves landing; an explicit revert or a file restored to baseline cancels that evidence. */
export async function landedNoteCommit(cwd: string, candidate: string): Promise<string | undefined> {
  if (!/^[a-f0-9]{7,40}$/.test(candidate)) return undefined
  try {
    const hash = await git(cwd, ['rev-parse', '--verify', `${candidate}^{commit}`])
    await git(cwd, ['merge-base', '--is-ancestor', hash, 'refs/heads/main'])
    const header = (await git(cwd, ['cat-file', '-p', hash])).split('\n\n', 1)[0]!
    const parent = /^parent ([a-f0-9]+)$/m.exec(header)?.[1]
    const files = (await git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z',
      ...(parent === undefined ? ['--root', hash] : [parent, hash]),
    ])).split('\0').filter(Boolean)
    if (files.length === 0) return undefined
    const messages = await git(cwd, ['log', '--format=%B', '--fixed-strings', `--grep=This reverts commit ${hash}.`, `${hash}..refs/heads/main`])
    if (messages.includes(`This reverts commit ${hash}.`)) return undefined
    const [before, confirmed, tip] = await Promise.all([
      parent === undefined ? new Map<string, string>() : entriesAt(cwd, parent, files),
      entriesAt(cwd, hash, files), entriesAt(cwd, 'refs/heads/main', files),
    ])
    if (files.some((file) => before.get(file) === tip.get(file))) return undefined
    for (const file of files) {
      if (confirmed.get(file) === tip.get(file)) continue
      if (modeOf(before.get(file)) !== modeOf(confirmed.get(file)) && modeOf(before.get(file)) === modeOf(tip.get(file))) return undefined
      // A later file-kind change is unknown, as in carriedChange; compare text only within the same kind.
      if (modeOf(confirmed.get(file)) !== modeOf(tip.get(file))) continue
      const [base, change, current] = await Promise.all([before, confirmed, tip].map(async (entries) => {
        const blob = entries.get(file)?.split(' ')[1]
        return blob === undefined ? [] : (await gitBytes(cwd, ['cat-file', 'blob', blob])).out.split('\n')
      }))
      // A later version may rewrite the feature; an absent change is the baseline with unrelated edits.
      if (regionMoved({ before: base!, confirmed: change!, tip: current! }) === 'absent') return undefined
    }
    return hash
  } catch { return undefined }
}

/**
 * Whether a commit on the target since the confirmation carried the file's confirmed
 * change, read commit by commit so a later rewrite does not take it back. The contents
 * decide for any commit: its version holds the change among edits around it. Ancestry
 * decides for the Session's own commits (`own`): one whose version neither shows nor
 * rules out the change counts, since the Session may have settled a conflict in those
 * lines its own way. One that verifiably lacks it does not.
 */
async function carriedInHistory(
  cwd: string, range: readonly string[], file: string, own: ReadonlySet<string>, entries: { before?: string; confirmed?: string },
): Promise<boolean> {
  for (const hash of names(await git(cwd, ['rev-list', '-z', ...range, '--', ...literals([file])]))) {
    const tip = (await entriesAt(cwd, hash, [file])).get(file)
    const key = [cwd, entries.before, entries.confirmed, tip].join('\0')
    let verdict = verdicts.get(key)
    if (verdict === undefined) {
      verdict = await carriedChange(cwd, { ...entries, tip })
      if (verdicts.size >= 20_000) verdicts.clear()
      verdicts.set(key, verdict)
    }
    if (verdict === 'yes' || (verdict === 'unknown' && own.has(hash))) return true
  }
  return false
}
/** A card Git cannot decide is read again after every exchange; its objects, and so each verdict, never change. */
const verdicts = new Map<string, Awaited<ReturnType<typeof carriedChange>>>()

/**
 * What a shared checkout held in a file apart from this Session: the approved entry with
 * the hunks its turns measured undone, newest first, each found exactly once by its text
 * and context. Anything else between that and HEAD came from outside its turns. When the
 * record is not exact (a turn unmeasured, failed or without hunks for the file, a
 * truncated diff, a rename, create or delete, a mode or end-of-file newline change, a
 * hunk not found, found twice or already in HEAD), this is `before`, so the whole-file check decides.
 */
async function ownChangeBase(
  cwd: string, file: string, before: string | undefined, confirmed: string | undefined, events: readonly ThreadEvent[],
): Promise<string | undefined> {
  const object = confirmed?.split(' ')[1]
  const original = before?.split(' ')[1]
  if (object === undefined || original === undefined || modeOf(before) !== modeOf(confirmed) ||
    !['100644', '100755'].includes(modeOf(confirmed) ?? '')) return before
  const isFile = async (raw: string) => path.isAbsolute(raw) && path.relative(cwd, await resolvedEntry(raw)) === file
  const results = events.flatMap((event) => event.type === 'turn_result' ? [event] : [])
  const measuredHere = await Promise.all(results.map(async (event) =>
    (await Promise.all((event.fileChangeRoots ?? []).map(resolved))).includes(cwd)))
  // A turn that ran tools and measured nothing here may have written this file.
  const toolTurns = new Set(events.flatMap((event) => event.type === 'tool_use' && event.turnId !== undefined ? [event.turnId] : []))
  if ([...toolTurns].some((turnId) => !results.some((event, at) => event.turnId === turnId && measuredHere[at]))) return before
  if (events.some((event) => (event.type === 'turn_result' || event.type === 'system_note') && event.fileChangesFailed === true)) return before
  const unmeasured = events.flatMap((event) => event.type === 'system_note' ? event.changedFiles ?? []
    : event.type === 'turn_result' ? event.fileChangeUnmeasured ?? [] : [])
  if ((await Promise.all(unmeasured.map(isFile))).includes(true)) return before
  const changes = []
  for (const event of results) {
    for (const change of event.fileChanges ?? []) {
      if (!await isFile(change.path) && !(change.oldPath !== undefined && await isFile(change.oldPath))) continue
      if (change.oldPath !== undefined || change.status !== 'edited' || change.diffTruncated === true || change.edits.length === 0 ||
        change.edits.some((edit) => edit.truncated === true || !edit.before || !edit.after)) return before
      changes.push(change)
    }
  }
  if (changes.length === 0) return before
  const [approved, earlier] = await Promise.all([object, original].map((hash) => gitBytes(cwd, ['cat-file', 'blob', hash])))
  // Hunks are UTF-8 text; bytes that do not round-trip cannot be matched faithfully.
  const utf8 = ({ code, out }: { code: number; out: string }) => {
    const decoded = Buffer.from(out, 'latin1').toString('utf8')
    return code === 0 && Buffer.from(decoded).equals(Buffer.from(out, 'latin1')) ? decoded : undefined
  }
  const text = utf8(approved!)
  const head = utf8(earlier!)
  if (text === undefined || head === undefined || text.endsWith('\n') !== head.endsWith('\n')) return before
  const lines = text.split('\n')
  const headLines = head.split('\n')
  const sitesOf = (fragment: readonly string[], within: readonly string[]) =>
    within.flatMap((_, at) => fragment.every((line, i) => within[at + i] === line) ? [at] : [])
  for (const change of changes.reverse()) {
    for (const edit of [...change.edits].reverse()) {
      const from = edit.after!.split('\n')
      const found = sitesOf(from, lines)
      // Text HEAD already held may be an older copy while the hunk's own site moved on.
      if (found.length !== 1 || sitesOf(from, headLines).length > 0) return before
      lines.splice(found[0]!, from.length, ...edit.before!.split('\n'))
    }
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'manor-completion-base-'))
  try {
    const base = path.join(temp, 'base')
    await writeFile(base, lines.join('\n'))
    return `${modeOf(before)} ${await git(cwd, ['hash-object', '-w', '--', base])}`
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/**
 * Success comes from Git, never from an agent's final sentence, and it asks one thing:
 * are this Session's confirmed changes on the branch they were meant for. That is the
 * Session's branch, or for an approved merge the branch it merges into. Three readings,
 * in order. A file has landed when a commit since the confirmation holds exactly its
 * confirmed entry, content and mode, whoever made that commit and whatever else it
 * carried (in a shared checkout another chat's commit may sweep it in). Then a commit
 * since the confirmation carried the change among edits around it (`carriedChange`), or
 * it is the Session's own commit on its worktree branch and its version does not
 * verifiably lack the change (`carriedInHistory`). Last, the branch's latest version
 * decides. In a shared checkout each comparison starts from the file without the
 * Session's own measured hunks (`ownChangeBase`), so another chat's uncommitted hunk in
 * the same file is not part of the change; an inexact record keeps the whole file. `blocked` means
 * verified missing: the branch lacks part of the change in lines it left alone, or kept
 * exactly what the change removed and added none of it. A version that rewrote the
 * changed lines another way may be a later one or a replacement; then nothing is
 * claimed, and a blocked card's reason becomes that Manor could not confirm it. When Git
 * cannot answer for a repo at all (a folder or branch gone), the held status stays and
 * only the steps the other reads prove are added.
 */
export async function observeWorkCompletion(held: WorkCompletion, events: readonly ThreadEvent[] = []): Promise<WorkCompletion> {
  if (held.operation === 'none') return held
  // The commit turn and anything after it must not redefine what was approved.
  const request = events.findIndex((event) => event.id === held.requestEventId)
  const approvedEvents = request < 0 ? events : events.slice(0, request)
  const commits: NonNullable<WorkCompletion['commits']> = []
  // The repos Git shows lacking part of the change, with only those files; the card's reason names the first.
  const missing: WorkCompletion['repos'] = []
  // The repos with files Git neither shows nor rules out, with only those files.
  const unsure: WorkCompletion['repos'] = []
  // The repos Git cannot answer for at all (a folder or branch gone); their steps stay as held.
  const unreadable = new Set<string>()
  for (const repo of held.repos) {
    try {
      // Branch refs and objects are shared with the linked folder, which outlives the worktree.
      const cwd = repo.sourcePath ?? repo.path
      const branch = repo.sourcePath !== undefined && repo.mergeInto !== undefined ? repo.mergeInto : repo.branch
      const tip = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
      const confirmed = await entriesAt(cwd, repo.tree, repo.files)
      const range = repo.before === '' ? [tip] : [tip, '--not', repo.before]
      // Oldest first, so each file is credited to the commit that first carried it.
      const candidates = (await git(cwd, ['rev-list', '--reverse', ...range, '--', ...literals(repo.files)])).split('\n').filter(Boolean)
      const open = new Set(repo.files)
      const own = new Set<string>()
      // Only a worktree branch's reflog says who committed. In a shared checkout an exact
      // file proves its contents, not its author.
      const authored = repo.sourcePath === undefined ? new Set<string>() : await sessionCommits(cwd, repo.branch)
      for (const hash of candidates) {
        if (open.size === 0) break
        const entries = await entriesAt(cwd, hash, repo.files)
        // The Session's commit of this approval holds part of it byte for byte, whether or
        // not an earlier commit already landed those files.
        if (authored.has(hash) && repo.files.some((file) => entries.get(file) === confirmed.get(file))) own.add(hash)
        const exact = [...open].filter((file) => entries.get(file) === confirmed.get(file))
        if (exact.length === 0) continue
        for (const file of exact) open.delete(file)
        commits.push({ path: repo.path, hash })
      }
      if (open.size === 0) continue
      const rest = [...open]
      const [atTip, atBefore] = await Promise.all([
        entriesAt(cwd, tip, rest),
        repo.before === '' ? new Map<string, string>() : entriesAt(cwd, repo.before, rest),
      ])
      const absent: string[] = []
      const undecided: string[] = []
      for (const file of rest) {
        const entries = { confirmed: confirmed.get(file), before: repo.sourcePath === undefined
          ? await ownChangeBase(cwd, file, atBefore.get(file), confirmed.get(file), approvedEvents)
          : atBefore.get(file) }
        if (await carriedInHistory(cwd, range, file, own, entries)) continue
        const verdict = await carriedChange(cwd, { ...entries, tip: atTip.get(file) })
        if (verdict === 'no') absent.push(file)
        else if (verdict === 'unknown') undecided.push(file)
      }
      if (absent.length > 0) missing.push({ ...repo, files: absent })
      if (undecided.length > 0) unsure.push({ ...repo, files: undecided })
    } catch {
      unreadable.add(repo.path)
    }
  }
  if (missing.length === 0 && unsure.length === 0 && unreadable.size === 0) {
    return { ...held, status: 'complete', completedAt: Date.now(), commits, message: undefined }
  }
  // An unfinished request may still have landed some repos and committed others: the
  // card ticks those steps and fails the first one still open, however fast the turn was.
  const open = new Set([...missing, ...unsure].map((repo) => repo.path).concat([...unreadable]))
  const landed = held.repos.flatMap((repo) => open.has(repo.path) ? [] : [repo.path])
  const committed = held.operation === 'merge'
    ? [...landed, ...await committedRepos({ ...held, repos: held.repos.filter((repo) => open.has(repo.path)) }, events)]
    : landed
  // A repo Git cannot read now keeps the steps an earlier read proved.
  const kept = (paths: string[] | undefined) => (paths ?? []).filter((path) => unreadable.has(path))
  const steps = {
    committed: nonEmpty([...new Set([...committed, ...kept(held.committed)])]),
    merged: held.operation === 'merge' ? nonEmpty([...landed, ...kept(held.merged)]) : undefined,
  }
  if (missing.length > 0) {
    return { ...held, ...steps, status: 'blocked', completedAt: undefined, commits: undefined, message: await blockedReason(held, missing, events) }
  }
  // A merge target Git cannot read leaves that merge undecided, never its commit.
  if (unreadable.size > 0) return { ...held, ...steps }
  // A reason Git no longer backs must not stand: the card names what Manor could not confirm.
  return held.status === 'blocked' ? unconfirmedCompletion({ ...held, ...steps }, unsure[0]) : { ...held, ...steps }
}

/**
 * The branch tips Confirm's steps depend on, the Session's branch and the merge target
 * per repo. A step can only change when one of them moves, so a watcher rereads after that.
 */
export async function stepTips(held: WorkCompletion): Promise<string> {
  const tips = await Promise.all(held.repos.flatMap((repo) => {
    const cwd = repo.sourcePath ?? repo.path
    const refs = repo.sourcePath !== undefined && repo.mergeInto !== undefined ? [repo.branch, repo.mergeInto] : [repo.branch]
    return refs.map((ref) => git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`]).catch(() => ''))
  }))
  return tips.join(' ')
}

const nonEmpty = (paths: string[] | undefined): string[] | undefined => paths !== undefined && paths.length > 0 ? paths : undefined

/**
 * Each repo's Confirm steps as Git shows them while the request runs: committed on the
 * Session's own branch, and for a merge also landed on the target. Read one repo at a
 * time, so one repo landing never waits on another.
 */
export async function repoSteps(held: WorkCompletion, events: readonly ThreadEvent[] = []): Promise<{ committed: string[]; merged: string[] }> {
  const committed: string[] = []
  const merged: string[] = []
  if (held.operation === 'none') return { committed, merged }
  for (const repo of held.repos) {
    const seen = await observeWorkCompletion({ ...held, repos: [repo], status: 'pending', committed: undefined, merged: undefined }, events)
    if (seen.status === 'complete' && held.operation === 'merge') merged.push(repo.path)
    if (seen.status === 'complete' || seen.committed !== undefined) committed.push(repo.path)
  }
  return { committed, merged }
}

/**
 * The repos whose commit Git already shows on the Session's own branch. Confirm's card
 * ticks each Commit from this before its Merge runs, so the merge target is dropped and
 * each repo is read on its own: one repo landing must not wait on another.
 */
export async function committedRepos(held: WorkCompletion, events: readonly ThreadEvent[] = []): Promise<string[]> {
  if (held.operation === 'none') return []
  const landed = await Promise.all(held.repos.map(async (repo) => {
    const own = { ...repo }
    delete own.mergeInto
    const seen = await observeWorkCompletion({ ...held, operation: 'commit', status: 'pending', committed: undefined, merged: undefined, repos: [own] }, events)
    return seen.status === 'complete' ? [repo.path] : []
  }))
  return landed.flat()
}

/**
 * The card's words when the linked folder holds uncommitted changes in files the merge
 * touches. The user's own changes are never moved by Manor, so the way out is theirs: commit or
 * stash them, then Retry. The action leads because both cards clamp the reason to two
 * lines. Paths stay whole since two package.json files are not one file.
 */
export function dirtyOverlapMessage(files: readonly string[]): string {
  const shown = files.slice(0, 4)
  const named = files.length > 4 ? `${shown.join(', ')} and ${files.length - 4} more` : shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
  return `Commit or stash your changes to ${named} in the linked folder, then press Retry. The merge changes those files too.`
}

const fileList = (files: readonly string[]): string => {
  const names = files.map((file) => path.basename(file))
  if (names.length <= 2) return names.join(' and ')
  return `${names[0]} and ${names.length - 1} more files`
}

/** The request that runs now: the newest Retry, or Confirm's own. */
export const attemptOf = (held: WorkCompletion): string | undefined => held.retries?.at(-1) ?? held.requestEventId

/** How long the stop line may run on the card before it is cut. */
const STOP_LINE_CHARS = 140

/**
 * The stop the lead reported for the attempt that runs now, in its own words: the first
 * sentence after "Real failure:", or "Your choice: <sentence>", which tells the user the
 * call is theirs. Without one, the turn's own error (a provider limit or crash) is the
 * reason, since the lead never got to report.
 */
export function stopLine(held: WorkCompletion, events: readonly ThreadEvent[]): string | undefined {
  const attempt = attemptOf(held)
  const from = attempt === undefined ? -1 : events.findIndex((event) => event.id === attempt)
  if (from < 0) return undefined
  let failure: string | undefined
  for (const event of events.slice(from + 1).reverse()) {
    if (event.type === 'system_note' && event.kind === 'error') failure ??= event.text.split('\n')[0]!.trim() || undefined
    if (event.type !== 'agent_message') continue
    const found = /(?:^|\n)[\s>*_#-]*(Real failure|Your choice)[*_]*:[*_]*\s*([^\n]+)/.exec(event.text)
    if (found === null) continue
    const rest = found[2]!.replace(/[*_`]+/g, '').trim()
    if (rest.length === 0) continue
    const sentence = /^.+?[.!?](?=\s|$)/.exec(rest)?.[0] ?? rest
    // "Your choice" tells the user the call is theirs; a real failure just says what broke.
    const line = found[1] === 'Your choice' ? `Your choice: ${sentence}` : `${sentence[0]!.toUpperCase()}${sentence.slice(1)}`
    return cut(line)
  }
  return failure === undefined ? undefined : cut(failure)
}

const cut = (line: string): string => line.length <= STOP_LINE_CHARS ? line : `${line.slice(0, STOP_LINE_CHARS - 1).trimEnd()}…`

/**
 * Why Git does not show a confirmed change on its branch, in one line the card shows
 * under Merge blocked or Commit blocked, for the first repo that lacks it. `missing`
 * holds only the files Git shows absent. The stop the lead reported comes first (a
 * failing hook, a conflict it left as the user's choice), since Git only sees its symptom,
 * the files still uncommitted. Then the folders themselves: the linked folder on
 * another branch, or holding uncommitted edits in those files, which a fast-forward
 * refuses to overwrite, or the target having moved past the Session's commit since its
 * rebase. Otherwise it names the missing files, or says the whole change is missing
 * when none of it landed.
 */
async function blockedReason(held: WorkCompletion, missing: WorkCompletion['repos'], events: readonly ThreadEvent[]): Promise<string> {
  const merge = held.operation === 'merge'
  const reported = stopLine(held, events)
  if (reported !== undefined) return reported
  for (const repo of missing) {
    const target = merge && repo.sourcePath !== undefined && repo.mergeInto !== undefined ? repo.mergeInto : repo.branch
    const folder = merge ? repo.sourcePath ?? repo.path : repo.path
    try {
      const on = await git(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
      if (merge && on !== target) return `The linked folder is on ${on || 'a detached HEAD'}, not ${target}.`
      // A shared checkout switched under the commit turn: the commit, if any, went to the wrong branch.
      if (!merge && repo.sourcePath === undefined && on !== target) return `${path.basename(folder)} is on ${on || 'a detached HEAD'}, not ${target}.`
      // Untrimmed: each entry starts with its two status columns, the first often a space.
      const { stdout } = await run(gitBinary(), ['status', '--porcelain', '-z', '--', ...literals(repo.files)], { cwd: folder, env: gitEnv(), encoding: 'utf8' })
      const dirty = stdout.split('\0').filter((line) => line.length > 3).map((line) => line.slice(3))
      if (dirty.length > 0) {
        return merge
          ? dirtyOverlapMessage(dirty)
          : `${fileList(dirty)} ${dirty.length === 1 ? 'is' : 'are'} not committed on ${target}.`
      }
      // The Session committed on its branch, but the target is no longer under that commit.
      if (merge && repo.sourcePath !== undefined && (await git(folder, ['rev-list', '--count', `refs/heads/${target}..refs/heads/${repo.branch}`]).catch(() => '0')) !== '0' &&
        !await git(folder, ['merge-base', '--is-ancestor', `refs/heads/${target}`, `refs/heads/${repo.branch}`]).then(() => true, () => false)) {
        return `${target} moved since the rebase.`
      }
    } catch {
      // A folder Git cannot read falls through to the plain reason.
    }
    const whole = held.repos.find((row) => row.path === repo.path)?.files.length === repo.files.length
    if (whole) return merge ? `The change is not on ${target} yet.` : `The change is not committed on ${target} yet.`
    return `${fileList(repo.files)} ${repo.files.length === 1 ? 'is' : 'are'} not ${merge ? 'on' : 'committed on'} ${target}.`
  }
  return merge ? 'The change is not merged yet.' : 'The change is not committed yet.'
}

/**
 * Why Retry may not reuse a blocked Confirm, or undefined when it may. The approval
 * covers the files as they were at Confirm (`tree`); Retry is offered only while each
 * repo's working copy still holds exactly those and is still on the branch it had
 * then (a Session worktree may also be detached mid-rebase). A Session-owned worktree
 * may differ elsewhere only by what its merge target holds, which a rebase brings in.
 * A merge whose linked folder left the target cannot succeed, so Retry waits for it.
 */
export async function retryRefusal(held: WorkCompletion): Promise<string | undefined> {
  if (held.operation === 'none') return 'Nothing to retry.'
  for (const repo of held.repos) {
    try {
      // The approval is for this branch; switched elsewhere, the commit would land there.
      // Only a Session's own worktree may sit detached, mid-rebase, which Retry finishes.
      const on = await git(repo.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
      if (on !== repo.branch && (repo.sourcePath === undefined || on !== '')) {
        return `Retry waits until ${path.basename(repo.sourcePath ?? repo.path)} is back on ${repo.branch}.`
      }
      const tree = await captureTurnTree(repo.path)
      // Without renames, a moved approved file still names its old path.
      const changed = names(await git(repo.path, ['diff', '--no-renames', '--name-only', '-z', repo.tree, tree]))
      const approved = changed.filter((file) => repo.files.includes(file))
      if (approved.length > 0) return `${fileList(approved)} changed since Confirm. Request a new result in the Session.`
      if (repo.sourcePath !== undefined) {
        const target = repo.mergeInto ?? (await git(repo.sourcePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''))
        const outside = []
        for (const file of changed) {
          const [now, there] = await Promise.all([entriesAt(repo.path, tree, [file]), target === '' ? new Map<string, string>() : entriesAt(repo.path, `refs/heads/${target}`, [file])])
          if (now.get(file) !== there.get(file)) outside.push(file)
        }
        if (outside.length > 0) return `${fileList(outside)} changed since Confirm. Request a new result in the Session.`
        if (repo.mergeInto !== undefined) {
          const on = await git(repo.sourcePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
          if (on !== repo.mergeInto) return `Retry waits until the linked folder is back on ${repo.mergeInto}.`
        }
      }
    } catch {
      return 'Manor could not read the Session checkout. Open the Session to finish it there.'
    }
  }
  return undefined
}

/**
 * A finished commit turn Git can neither confirm nor rule out; the card must not keep
 * saying Merging…. A recheck that knows which repo's files Git cannot decide names them.
 */
export const unconfirmedCompletion = (held: WorkCompletion, unsure?: WorkCompletion['repos'][number]): WorkCompletion => {
  const repo = unsure ?? held.repos[0]
  const target = held.operation === 'merge' ? repo?.mergeInto : repo?.branch
  return {
    ...held, status: 'blocked', completedAt: undefined, commits: undefined,
    message: unsure !== undefined
      ? `Manor could not confirm ${fileList(unsure.files)} on ${target ?? 'the branch'}.`
      : held.operation === 'merge'
        ? `Manor could not confirm the merge into ${target ?? 'the branch'}.`
        : `Manor could not confirm the commit on ${target ?? 'the branch'}.`,
  }
}
