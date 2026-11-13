import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { MERGE_FIX_DIFF_MAX, type WorkCompletion, type WorkMerge } from '@manor/contracts'
import { failingChecks, gitEnv } from './sessionGit.js'
import { currentSessionCommits, dirtyOverlapMessage } from './workCompletion.js'
import { gitBinary } from './gitBinary.js'

/**
 * Manor's own merge of a confirmed worktree Session (2026-10-19). After Manor commits with the
 * lead's message at Confirm, it rebases the branch onto the target in the Session's worktree,
 * reruns the pre-commit hook when the branch moved (a rebase skips it), and fast-forwards the linked folder. Nothing
 * here stashes, resets or switches the linked folder: it only ever takes a fast-forward,
 * which Git refuses rather than overwrite anyone's local changes.
 */

type Repo = WorkCompletion['repos'][number]
type Trouble = NonNullable<WorkMerge['trouble']>
type Fix = NonNullable<WorkMerge['fix']>

/** What one merge attempt of a Session ended in. `verified` carries the tips the hook passed. */
export type MergeOutcome =
  /** `landed` is each repo's tip as the target holds it. */
  | { kind: 'merged'; verified: Record<string, string>; landed: { path: string; hash: string }[] }
  /** The lead gets one message with Git's own words. */
  | { kind: 'trouble'; trouble: Omit<Trouble, 'eventId'>; verified: Record<string, string> }
  /** The lead's conflict fix waits for the user's approval on the card. */
  | { kind: 'approve'; fix: Fix; verified: Record<string, string> }
  /** The user's move: the linked folder, its branch or the history is not what the approval covered. */
  | { kind: 'blocked'; message: string; verified?: Record<string, string> }

const HOOK_TIMEOUT_MS = 15 * 60_000
const GIT_TIMEOUT_MS = 2 * 60_000
/** How often a fast-forward that lost to a moved target rebases again before it gives up. */
const FAST_FORWARD_ATTEMPTS = 3
const TAIL_LINES = 40
/** WorkMergeSchema's bound on `trouble.text`, which rides on every directory message. */
const TROUBLE_TEXT_MAX = 4_000

const exec = promisify(execFile)

/** Git with the user's own config, so a rebase commits as them; both streams whatever the exit. */
async function git(cwd: string, args: readonly string[], timeout = GIT_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(gitBinary(), [...args], { cwd, env: gitEnv(), encoding: 'utf8', timeout, maxBuffer: 64_000_000 })
    return { ok: true, stdout, stderr }
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
    if (failed.killed === true) return { ok: false, stdout: failed.stdout ?? '', stderr: 'Git took too long and was stopped.' }
    return { ok: false, stdout: failed.stdout ?? '', stderr: failed.stderr ?? failed.message ?? '' }
  }
}
async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args)
  if (!result.ok) throw new Error(lastLine(result.stderr) ?? `git ${args[0]} failed`)
  return result.stdout.trim()
}
const said = (result: { stdout: string; stderr: string }) => `${result.stdout}\n${result.stderr}`
const tipOf = (cwd: string, branch: string) => gitText(cwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
const isAncestor = async (cwd: string, older: string, newer: string) => (await git(cwd, ['merge-base', '--is-ancestor', older, newer])).ok
const lines = (output: string) => output.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0 && !line.startsWith('hint:'))
const lastLine = (output: string) => lines(output).at(-1)?.trim()
const tail = (output: string) => lines(output).slice(-TAIL_LINES).join('\n')
/** Git's own explanation on one line, without its "error:" prefixes and closing "Aborting". */
const reasonOf = (output: string) =>
  lines(output).map((line) => line.trim().replace(/^(error|fatal): /, '')).filter((line) => line !== 'Aborting').join(' ').slice(0, 300) || undefined
const firstLine = (text: string) => text.split('\n')[0] ?? text
/** A stop line, then as much of Git's output from its end as the wire allows. */
export const troubleText = (head: string, output: string) => {
  const room = TROUBLE_TEXT_MAX - head.length - 2
  const said = tail(output)
  return room <= 0 ? head.slice(0, TROUBLE_TEXT_MAX) : `${head}\n${said.length > room ? `…${said.slice(said.length - room + 1)}` : said}`
}

/**
 * Files in the linked folder that fast-forwarding it to `tip` would overwrite or collide
 * with: uncommitted changes, untracked files and ignored files too (a merge overwrites an
 * ignored file without asking). Read right before the fast-forward, when `tip` sits on the
 * target and its diff against the target is exactly what lands, so the card can say what
 * to do instead of passing on Git's refusal. A file against a directory of the same name
 * collides too. Only the touched paths and their parent folders are asked about.
 */
export async function dirtyOverlap(source: string, into: string, tip: string): Promise<string[]> {
  // Not through gitText: its trim would eat a leading space in the first path or status column.
  const changed = await git(source, ['diff', '--name-only', '-z', '--no-renames', `refs/heads/${into}`, tip])
  if (!changed.ok) throw new Error(lastLine(changed.stderr) ?? 'git could not compare the linked folder')
  const touched = changed.stdout.split('\0').filter(Boolean)
  if (touched.length === 0) return []
  const parents = new Set(touched.flatMap((file) => file.split('/').slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join('/'))))
  // A parent that is a file here collides with the folder the merge puts in its place, but
  // only when it is not a clean tracked file the branch simply replaces: status decides.
  const filesAsParents: string[] = []
  for (const parent of parents) {
    if (await lstat(path.join(source, parent)).then((stat) => !stat.isDirectory(), () => false)) filesAsParents.push(parent)
  }
  const read = await git(source, ['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', ...touched, ...filesAsParents])
  if (!read.ok) throw new Error(lastLine(read.stderr) ?? 'git status failed')
  const status = read.stdout.split('\0')
  const dirty: string[] = []
  const ignoredFolders: string[] = []
  // Entries are "XY path"; a rename or copy carries its old path as the next field. Git
  // collapses a wholly ignored folder into one entry ending in a slash, which says nothing
  // about the files the merge adds inside it: those are looked at one by one below.
  for (let at = 0; at < status.length; at++) {
    const entry = status[at]!
    if (entry.length <= 3) continue
    const file = entry.slice(3)
    if (file.endsWith('/')) ignoredFolders.push(file.slice(0, -1))
    else dirty.push(file)
    if (entry[0] === 'R' || entry[0] === 'C') dirty.push(status[++at] ?? '')
  }
  const exists = (file: string) => lstat(path.join(source, file)).then(() => true, () => false)
  for (const folder of ignoredFolders) {
    for (const file of touched) {
      if (file === folder || (file.startsWith(`${folder}/`) && await exists(file))) dirty.push(file)
    }
  }
  return [...new Set(dirty)].filter((file) => touched.some((other) => other === file || other.startsWith(`${file}/`) || file.startsWith(`${other}/`))).sort()
}

/** The branch a folder is on, or undefined when HEAD is detached or unreadable. */
async function branchOf(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return result.ok ? result.stdout.trim() || undefined : undefined
}

/**
 * Puts a worktree back on its branch after a hook run a crash interrupted: HEAD detached
 * on an older commit with the branch's own tree in the index, exactly what `runHook` leaves.
 */
async function reattach(worktree: string, branch: string): Promise<void> {
  if (await branchOf(worktree) !== undefined) return
  if ((await git(worktree, ['diff', '--quiet', '--cached', `refs/heads/${branch}`])).ok) {
    await gitText(worktree, ['symbolic-ref', '-m', 'manor: back on the branch after an interrupted check', 'HEAD', `refs/heads/${branch}`])
  }
}

/**
 * Runs the repo's pre-commit hook against the branch tip as if it were committed on
 * `base` again: HEAD points at `base` for the run, so the hook sees the whole change as
 * staged, while the branch, the index and the files stay as they are.
 */
async function runHook(worktree: string, branch: string, base: string): Promise<{ ok: boolean; output: string }> {
  await gitText(worktree, ['update-ref', '--no-deref', '-m', 'manor: pre-commit check after rebase', 'HEAD', base])
  try {
    const result = await git(worktree, ['hook', 'run', '--ignore-missing', 'pre-commit'], HOOK_TIMEOUT_MS)
    return { ok: result.ok, output: said(result) }
  } finally {
    await gitText(worktree, ['symbolic-ref', '-m', 'manor: pre-commit check done', 'HEAD', `refs/heads/${branch}`])
  }
}

/**
 * Rebases the branch onto `target` in its own worktree; a conflict is aborted, never left
 * half done. The rebase runs on a detached HEAD and the branch moves only once the result
 * is checked, so an interrupted run leaves the branch where the lead put it.
 */
async function rebase(repo: Repo, target: string): Promise<{ ok: true; tip: string } | { ok: false; trouble: Omit<Trouble, 'eventId'> } | { ok: false; blocked: string }> {
  const before = await tipOf(repo.path, repo.branch)
  const base = await gitText(repo.path, ['merge-base', before, target])
  const into = repo.mergeInto ?? 'the target'
  const ref = `refs/heads/${repo.branch}`
  const failed = (head: string, output: string) => ({ ok: false as const, trouble: { kind: 'rebase' as const, repo: repo.path, tip: before, text: output === '' ? head : troubleText(head, output) } })
  const detached = await git(repo.path, ['checkout', '-q', '--detach', before])
  if (!detached.ok) return failed(`Manor could not start rebasing ${repo.branch} onto ${into}.`, said(detached))
  // Back on the branch, which still points at `before` unless the checked result moved it.
  const onBranch = () => git(repo.path, ['checkout', '-q', repo.branch])
  const result = await git(repo.path, ['-c', 'rebase.autoStash=false', '-c', 'rebase.updateRefs=false', '-c', 'commit.gpgSign=false',
    'rebase', '--no-autostash', target])
  if (!result.ok) {
    const conflicted = (await git(repo.path, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    await git(repo.path, ['rebase', '--abort'])
    await onBranch()
    if (conflicted.length > 0) {
      return { ok: false, trouble: {
        kind: 'conflict', repo: repo.path, base, tip: before,
        text: troubleText(`Rebasing ${repo.branch} onto ${into} stopped on a conflict in ${conflicted.join(', ')}; Manor aborted that rebase.`, said(result)),
      } }
    }
    return failed(`Rebasing ${repo.branch} onto ${into} failed.`, said(result))
  }
  // Replaying commits one by one can differ from merging the branch: a commit the target
  // already holds is skipped, and a later one undoes the target's copy. Only a rebase
  // that ends where Git's merge of the same tip ends moves the branch, so nothing changes unseen.
  const tip = await gitText(repo.path, ['rev-parse', 'HEAD'])
  const merged = await git(repo.path, ['merge-tree', '--write-tree', '--merge-base', base, target, before])
  const replayed = await gitText(repo.path, ['rev-parse', `${tip}^{tree}`])
  // A merge driver may print before the tree id Git writes last.
  if (merged.ok && merged.stdout.trim().split('\n').at(-1) === replayed) {
    // Git's own rebase wording, which the reflog reading of the Session's commits relies on.
    const moved = await git(repo.path, ['update-ref', '-m', `rebase (finish): ${ref} onto ${target}`, ref, tip, before])
    if (!moved.ok) {
      await onBranch()
      return failed(`Manor could not move ${repo.branch} to its rebase onto ${into}.`, said(moved))
    }
    await gitText(repo.path, ['symbolic-ref', '-m', 'manor: back on the branch after the rebase', 'HEAD', ref])
    return { ok: true, tip }
  }
  const back = await onBranch()
  if (!back.ok) {
    return { ok: false, blocked: `Rebasing ${repo.branch} onto ${into} gave a different result than merging it would, and Manor could not return the worktree to the branch: ${lastLine(said(back)) ?? 'Git gave no reason'}` }
  }
  return failed(`Rebasing ${repo.branch} onto ${into} replayed its commits into a different result than merging it would, so Manor left the branch as it was. Squash the branch into one commit so the rebase and the merge agree.`, '')
}

type RepoOutcome = Exclude<MergeOutcome, { kind: 'merged' }> | { kind: 'landed'; verified: Record<string, string>; tip: string }

/**
 * One repo, start to landing. A repo whose branch the target already holds has nothing
 * to do. `verified` holds the tip the pre-commit hook last passed on per worktree: the
 * lead's own commit, or Manor's earlier run. A tip the hook has not seen is checked first.
 * A failure is sent to the lead once per branch tip: the same failure on a tip the lead
 * left as it was is the user's move.
 */
async function mergeRepo(repo: Repo, merge: WorkMerge, verified: Record<string, string>): Promise<RepoOutcome> {
  const into = repo.mergeInto
  const source = repo.sourcePath
  if (into === undefined || source === undefined) return { kind: 'blocked', message: 'Manor has no merge target for this Session.' }
  await reattach(repo.path, repo.branch)
  const on = await branchOf(source)
  if (on !== into) return { kind: 'blocked', message: `The linked folder is on ${on ?? 'a detached HEAD'}, not ${into}.` }
  let tip = await tipOf(source, repo.branch)

  const before = merge.trouble?.repo === repo.path ? merge.trouble : undefined
  const repeated = (trouble: Omit<Trouble, 'eventId'>) => before?.kind === trouble.kind && before.tip === trouble.tip
  // The lead changed its commit after a conflict Manor sent it: the user sees that change
  // unless it only kept both sides' lines. Manor's own clean rebase afterwards needs no
  // second look. Judged before anything counts as landed, since a fix that skipped the
  // Session's own commit lands trivially.
  const conflict = merge.conflicts?.[repo.path]
  const approved = merge.approved?.[repo.path]
  if (conflict !== undefined && tip !== conflict.tip && tip !== approved) {
    const fix = await conflictFix(repo, conflict, tip, approved !== undefined)
    if (fix !== undefined) return { kind: 'approve', fix, verified }
  }
  if (await isAncestor(source, tip, `refs/heads/${into}`)) return { kind: 'landed', verified, tip }

  // The approval covers this Session's commits alone: the lead's, its amends and the rebases of them.
  const own = await currentSessionCommits(source, repo.branch)
  const foreign = (await gitText(source, ['rev-list', `refs/heads/${into}..${tip}`])).split('\n').filter((hash) => hash.length > 0 && !own.has(hash))
  if (foreign.length > 0) {
    return { kind: 'blocked', message: `Your choice: ${repo.branch} carries ${foreign.length === 1 ? 'a commit' : `${foreign.length} commits`} this approval does not cover (${foreign.slice(0, 3).map((hash) => hash.slice(0, 8)).join(', ')}).` }
  }

  for (let attempt = 0; ; attempt++) {
    const target = await tipOf(source, into)
    if (!await isAncestor(source, target, tip)) {
      const rebased = await rebase(repo, target)
      if (!rebased.ok) {
        if ('blocked' in rebased) return { kind: 'blocked', message: rebased.blocked }
        return repeated(rebased.trouble)
          ? { kind: 'blocked', message: firstLine(rebased.trouble.text) }
          : { kind: 'trouble', trouble: rebased.trouble, verified }
      }
      tip = rebased.tip
    }
    if (verified[repo.path] !== tip) {
      const base = await gitText(source, ['merge-base', tip, target])
      const tracked = async () => (await git(repo.path, ['status', '--porcelain', '--untracked-files=no'])).stdout
      const checked = await runHook(repo.path, repo.branch, base)
      // A hook that rewrites files passed its own fix, not the commit that would land; any
      // tracked change left in the worktree means the commit is not what was checked.
      const left = checked.ok ? await tracked() : ''
      const rewrote = left !== ''
      if (!checked.ok || rewrote) {
        const failing = failingChecks(lines(checked.output), 'commit')
        const trouble = { kind: 'hook' as const, repo: repo.path, tip, text: rewrote
          ? troubleText(`After the pre-commit hook ran on ${repo.branch} rebased onto ${into}, the worktree holds changes the commit does not.`, left)
          : troubleText(`The pre-commit hook failed on ${repo.branch} after it was rebased onto ${into}.${failing === undefined ? '' : ` ${failing}`}`, checked.output) }
        return repeated(trouble) ? { kind: 'blocked', message: firstLine(trouble.text) } : { kind: 'trouble', trouble, verified }
      }
      verified = { ...verified, [repo.path]: tip }
    }
    // A hook can run for minutes: the folder must still be on the target, and only the
    // commit the checks passed lands, whatever the branch ref points at by now.
    const now = await branchOf(source)
    if (now !== into) return { kind: 'blocked', message: `The linked folder is on ${now ?? 'a detached HEAD'}, not ${into}.` }
    // The user's own edits are never moved: they commit or stash them and Retries, and the
    // hook result kept here spares that Retry another run.
    const dirty = await dirtyOverlap(source, into, tip)
    if (dirty.length > 0) return { kind: 'blocked', message: dirtyOverlapMessage(dirty), verified }
    const landed = await git(source, ['merge', '--ff-only', '--no-edit', tip])
    if (landed.ok) return { kind: 'landed', verified, tip }
    // Another commit reached the target between the rebase and the fast-forward: go again.
    if (await tipOf(source, into) !== target && attempt + 1 < FAST_FORWARD_ATTEMPTS) continue
    return { kind: 'blocked', message: `The fast-forward into ${into} was refused: ${reasonOf(landed.stderr) ?? reasonOf(landed.stdout) ?? 'Git gave no reason'}` }
  }
}

/** Merges every repo of a confirmed Session in turn, and stops at the first that cannot land. */
export async function mergeSession(completion: WorkCompletion, merge: WorkMerge): Promise<MergeOutcome> {
  let verified = { ...merge.verified }
  const landed: { path: string; hash: string }[] = []
  for (const repo of completion.repos) {
    const outcome = await mergeRepo(repo, merge, verified)
    if (outcome.kind !== 'landed') return outcome
    verified = outcome.verified
    landed.push({ path: repo.path, hash: outcome.tip })
  }
  return { kind: 'merged', verified, landed }
}

/** The branch tips the lead's commit turn left, each one the hook already passed. */
export async function committedTips(completion: WorkCompletion): Promise<Record<string, string>> {
  const tips: Record<string, string> = {}
  for (const repo of completion.repos) {
    const tip = await tipOf(repo.sourcePath ?? repo.path, repo.branch).catch(() => undefined)
    if (tip !== undefined) tips[repo.path] = tip
  }
  return tips
}

/** A path's mode and blob in a commit, or undefined where the commit has nothing there. */
async function entryAt(cwd: string, commit: string, file: string) {
  // Literal pathspecs: a file named `:(top)x` is that file, never `x`.
  const line = (await gitText(cwd, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', file]).catch(() => '')).split('\0')[0] ?? ''
  const tab = line.indexOf('\t')
  const [mode, type, blob] = line.slice(0, tab).split(' ')
  return tab > 0 && line.slice(tab + 1) === file && type === 'blob' && mode !== undefined && blob !== undefined ? { mode, blob } : undefined
}

/**
 * Whether the lead resolved one conflicted file by only keeping both sides: its bytes are
 * Git's union merge of the target's version, then the Session's. The
 * union only counts when the same merge without it reproduces the conflicted file Git's
 * own merge wrote, so both describe the same conflict. Binary files, symlinks and paths a
 * side added or deleted never qualify, and dropping or rewriting a line is a change of
 * behaviour the user sees, whatever the lead thinks of it.
 */
async function keepsBothSides(cwd: string, merge: { base: string; onto: string; tip: string; tree: string }, fixed: string, file: string): Promise<boolean> {
  const { base, onto, tip, tree } = merge
  const [from, ours, theirs, marked, resolved] = await Promise.all([base, onto, tip, tree, fixed].map((commit) => entryAt(cwd, commit, file)))
  const text = (entry: { mode: string } | undefined) => entry?.mode === '100644' || entry?.mode === '100755'
  if (!(text(from) && text(ours) && text(theirs) && text(marked) && text(resolved))) return false
  // The labels and algorithm merge-tree uses, so the conflicted blobs match byte for byte.
  const mergeFile = (first: string, second: string, ...style: string[]) => git(cwd, ['-c', 'merge.conflictStyle=merge',
    'merge-file', '--object-id', '--diff-algorithm=histogram', ...style, '-L', onto, '-L', base, '-L', tip, first, from!.blob, second])
  if ((await mergeFile(ours!.blob, theirs!.blob)).stdout.trim() !== marked!.blob) return false
  const union = await mergeFile(ours!.blob, theirs!.blob, '--union')
  return union.ok && union.stdout.trim() === resolved!.blob
}

/**
 * The lead's conflict resolution as a diff against Git's own merge of the same change
 * onto the same target commit, conflict markers and all. Undefined only on the first
 * conflict, nothing approved yet, when it is Git's own union of the conflict or its
 * clean merge. A later round shows everything that would land, and a commit rewritten
 * without a rebase shows what it changed. Git decides, never the lead's account of it.
 */
async function conflictFix(repo: Repo, conflict: { base: string; tip: string; again?: boolean }, fixed: string, approvedBefore: boolean): Promise<Fix | undefined> {
  const { base, tip } = conflict
  const cwd = repo.sourcePath ?? repo.path
  const into = repo.mergeInto ?? 'target'
  const onto = await gitText(cwd, ['merge-base', fixed, `refs/heads/${into}`])
  if (onto === base) return fixDiff(cwd, repo.path, fixed, [{ from: tip, label: 'session' }])
  if (conflict.again === true || approvedBefore) return fixDiff(cwd, repo.path, fixed, [{ from: onto, label: into }])
  const merged = await git(cwd, ['-c', 'merge.conflictStyle=merge', 'merge-tree', '--write-tree', '--name-only', '-z',
    '--merge-base', base, onto, tip])
  // The tree, then each conflicted path, then an empty field before Git's messages.
  const fields = merged.stdout.split('\0')
  const tree = fields[0]?.trim() ?? ''
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return fixDiff(cwd, repo.path, fixed, [{ from: onto, label: into }])
  const conflicted = new Set(fields.slice(1, fields.indexOf('', 1) < 0 ? undefined : fields.indexOf('', 1)))
  // Raw entries pair `:oldmode newmode oldblob newblob status` with the path.
  const raw = (await gitText(cwd, ['diff', '--raw', '--no-renames', '--ignore-submodules=none', '-z', tree, fixed])).split('\0').filter(Boolean)
  const entries = Array.from({ length: Math.floor(raw.length / 2) }, (_, at) => {
    const [fromMode, toMode, fromBlob, toBlob] = raw[at * 2]!.slice(1).split(' ')
    return { file: raw[at * 2 + 1]!, modeChanged: fromMode !== toMode, sameText: fromBlob === toBlob }
  })
  // Lines outside the conflicts, or a file's mode, are never "both sides".
  const outside = entries.some(({ modeChanged, file }) => modeChanged || !conflicted.has(file))
  // Every conflicted path must prove it kept both sides.
  const unproven: string[] = []
  for (const file of conflicted) {
    if (!await keepsBothSides(cwd, { base, onto, tip, tree }, fixed, file)) unproven.push(file)
  }
  if (!outside && unproven.length === 0) return undefined
  // A path left exactly as Git's tree hides which side it dropped: it shows against the
  // target and the Session's own commit too, and the side the fix kept diffs empty.
  const hidden = unproven.filter((file) => entries.find((entry) => entry.file === file)?.sameText !== false)
  return fixDiff(cwd, repo.path, fixed, [
    { from: tree, label: 'git-merge' },
    ...(hidden.length === 0 ? [] : [{ from: onto, label: into, paths: hidden }, { from: tip, label: 'session', paths: hidden }]),
  ])
}

/** The fix as the user reads it: each comparison's old side named by its source, the lead's commit as `fix/`. */
async function fixDiff(cwd: string, repo: string, to: string, against: readonly { from: string; label: string; paths?: readonly string[] }[]): Promise<Fix> {
  const files = new Set<string>()
  let diff = ''
  for (const { from, label, paths = [] } of against) {
    const only = paths.length === 0 ? [] : ['--', ...paths]
    for (const file of (await gitText(cwd, ['--literal-pathspecs', 'diff', '--name-only', '--ignore-submodules=none', '-z', from, to, ...only])).split('\0').filter(Boolean)) files.add(file)
    diff += (await git(cwd, ['--literal-pathspecs', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-color', '--no-textconv', '--ignore-submodules=none',
      `--src-prefix=${label}/`, '--dst-prefix=fix/', from, to, ...only])).stdout
  }
  const truncated = diff.length > MERGE_FIX_DIFF_MAX
  return { repo, tip: to, files: [...files].slice(0, 500), diff: truncated ? diff.slice(0, MERGE_FIX_DIFF_MAX) : diff, ...(truncated ? { truncated: true } : {}) }
}

/**
 * One merge at a time per linked folder, in Confirm order. Confirm reserves a place while
 * the lead's commit turn runs; `add` makes it runnable, and the turn's end releases a
 * reservation nothing made runnable. A Session with worktrees in several linked folders waits for all of
 * them, and nobody behind it in any of its folders passes it.
 */
export class MergeLanes {
  private readonly waiting: { id: string; folders: readonly string[]; ready: boolean }[] = []
  private readonly running = new Map<string, readonly string[]>()
  /** Sessions confirmed again while their earlier merge still ran: they go again after it. */
  private readonly again = new Set<string>()

  constructor(private readonly run: (id: string) => Promise<void>, private readonly changed: () => void) {}

  /** Whether the merge runs or waits ready to run; a reservation alone does not count. */
  has(id: string): boolean {
    return this.running.has(id) || this.waiting.some((job) => job.id === id && job.ready)
  }

  /** Holds a place in each folder's line for a merge whose commit turn still runs. */
  reserve(id: string, folders: readonly string[]): void {
    if (this.running.has(id) || this.waiting.some((job) => job.id === id)) return
    this.waiting.push({ id, folders: [...new Set(folders)], ready: false })
    this.changed()
  }

  /** Queues a merge, at its reserved place when it has one; false when it is already queued or running. */
  add(id: string, folders: readonly string[]): boolean {
    if (this.running.has(id) && !this.again.has(id)) {
      this.again.add(id)
      return true
    }
    if (this.has(id)) return false
    const held = this.waiting.find((job) => job.id === id)
    if (held !== undefined) held.ready = true
    else this.waiting.push({ id, folders: [...new Set(folders)], ready: true })
    this.pump()
    this.changed()
    return true
  }

  release(id: string): void {
    const at = this.waiting.findIndex((job) => job.id === id && !job.ready)
    if (at < 0) return
    this.waiting.splice(at, 1)
    this.pump()
    this.changed()
  }

  /** Each waiting merge's place: the merge directly ahead of it in a shared folder, and how many are ahead. */
  positions(): Map<string, { after: string; ahead: number }> {
    const order = [...[...this.running].map(([id, folders]) => ({ id, folders })), ...this.waiting]
    const places = new Map<string, { after: string; ahead: number }>()
    for (const [index, job] of order.entries()) {
      if (this.running.has(job.id)) continue
      const before = order.slice(0, index).filter((other) => other.folders.some((folder) => job.folders.includes(folder)))
      const after = before.at(-1)
      if (after !== undefined) places.set(job.id, { after: after.id, ahead: before.length })
    }
    return places
  }

  private pump(): void {
    const claimed = new Set([...this.running.values()].flat())
    for (const job of [...this.waiting]) {
      const free = job.folders.every((folder) => !claimed.has(folder))
      for (const folder of job.folders) claimed.add(folder)
      if (!free || !job.ready) continue
      this.waiting.splice(this.waiting.indexOf(job), 1)
      this.running.set(job.id, job.folders)
      void this.run(job.id).catch(() => undefined).finally(() => {
        this.running.delete(job.id)
        if (this.again.delete(job.id)) this.waiting.unshift({ ...job, ready: true })
        this.pump()
        this.changed()
      })
    }
  }
}
