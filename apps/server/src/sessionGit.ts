import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  MAX_SESSION_DIFF_FILES,
  type SessionDiffFile,
  type SessionDiffHunk,
  type SessionFileStat,
  type SessionRepo,
  type WorkCompletion,
} from '@manor/contracts'
import type { ChatWorktree } from './store.js'
import { folderLabels, isPreviewablePath } from './repoFiles.js'
import { captureTurnTree, parseNumstat, parseStatuses } from './turnFileSnapshots.js'
import { resolvedEntry } from './workCompletion.js'
import { currentBranch, gitRoots } from './worktree.js'
import { childProcessEnv } from './childEnv.js'
import { gitBinary } from './gitBinary.js'

const run = promisify(execFile)

/**
 * Git with the user's own config, so a commit carries their identity and a push their
 * credential helper, minus whatever a hook exported: a push from a linked worktree
 * sets `GIT_DIR`, and a child that inherits it acts on the wrong repository. Never a
 * prompt: a push that needs a password fails with the reason instead of hanging.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return childProcessEnv(process.env, [
    'SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  ], { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' })
}

/** A failure that carries what Git said, for the sentence the user reads. */
/** Git refused; `output` keeps its full words for a reader that gets more room than one line. */
export class SessionGitError extends Error {
  constructor(message: string, readonly output?: string) { super(message) }
}

async function git(cwd: string, args: readonly string[], options: { maxBuffer?: number; timeout?: number } = {}): Promise<string> {
  try {
    const { stdout } = await run(gitBinary(), [...args], {
      cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: options.maxBuffer ?? 8_000_000, timeout: options.timeout ?? 60_000,
    })
    return stdout
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string; message?: string; killed?: boolean }
    if (failed.killed === true) throw new SessionGitError('Git took too long and was stopped.')
    const said = `${failed.stderr ?? ''}\n${failed.stdout ?? ''}`.split('\n').map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('hint:'))
    throw new SessionGitError(said.at(-1) ?? failed.message ?? 'Git failed.')
  }
}

const tryGit = (cwd: string, args: readonly string[]) => git(cwd, args).then((out) => out.trim(), () => undefined)

/** Both streams whatever the exit, for a command whose refusal is in its normal output. */
export async function gitOutput(cwd: string, args: readonly string[], timeout: number): Promise<{ ok: boolean; output: string }> {
  try {
    // A hook's full test output lands here too, failures and all.
    const { stdout, stderr } = await run(gitBinary(), [...args], { cwd, env: gitEnv(), encoding: 'utf8', timeout, maxBuffer: 64_000_000 })
    return { ok: true, output: `${stdout}\n${stderr}` }
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string; message?: string; killed?: boolean }
    if (failed.killed === true) return { ok: false, output: 'Git took too long and was stopped.' }
    return { ok: false, output: `${failed.stdout ?? ''}\n${failed.stderr ?? failed.message ?? ''}` }
  }
}
const literal = (file: string) => `:(literal)${file}`

/** Every diff here reads the same way whatever the user's diff settings are. */
const DIFF = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false',
  'diff', '--no-ext-diff', '--no-color', '--no-textconv', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/']

/** Changed lines one Session diff carries before it says it is partial. */
export const MAX_DIFF_LINES = 12_000
/** Changed lines one file may have and still show its hunks. */
export const MAX_FILE_DIFF_LINES = 3_000
/** A line longer than this is cut, a minified bundle being the usual culprit. */
const MAX_LINE_CHARS = 2_000

/** A Session's checkout as Manor knows it. */
export interface SessionCheckout {
  /** The folders turns see: worktree paths where the chat is isolated. */
  repoPaths: readonly string[]
  mapping: readonly ChatWorktree[]
  /** Absolute paths this Session's turns changed, `sessionChangedFiles`. */
  sessionFiles: readonly string[]
  /** A result waiting for Confirm. Its scope is exactly what Confirm lands. */
  waiting?: WorkCompletion
  /**
   * With `waiting`: every path the Session's turns changed, `sessionFiles` being the
   * result's own. What the live scope holds beyond the result is its Not included.
   */
  liveFiles?: readonly string[]
}

/** One git folder and what the Session would land in it. */
interface ScopedRepo {
  root: string
  /** Git's own name for the folder; Confirm's completion records this one. */
  top: string
  label: string
  /** Empty before the first commit. */
  head: string
  base: string
  target: string
  /** Repo-relative paths in the whole-Session scope. */
  files: string[]
  /** Repo-relative paths Commit may take: this Session's, uncommitted, committable. */
  uncommitted: string[]
  mapping?: ChatWorktree
  /** While a result waits: the Session's changed files it leaves out, measured live. */
  excluded?: { base: string; target: string; files: string[] }
}

async function sameDir(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([realpath(left).catch(() => left), realpath(right).catch(() => right)])
  return a === b
}

/** The empty tree in this repository's own hash, for a repository with no commit yet. */
const emptyTree = (top: string) => git(top, ['hash-object', '-t', 'tree', '/dev/null']).then((out) => out.trim())

/** Of `files`, those Git could commit: tracked at `base`, or present and not ignored. */
async function committable(top: string, base: string, files: readonly string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set()
  const specs = files.map(literal)
  const tracked = base === '' ? '' : await git(top, ['ls-tree', '-r', '--name-only', '-z', base, '--', ...specs])
  const present = await git(top, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...specs])
  return new Set(`${tracked}\0${present}`.split('\0').filter(Boolean))
}

/**
 * Paths that differ between two trees, both sides of a rename listed on their own so a
 * scope that takes one also takes the other. `files` narrows it; `'all'` reads every path.
 */
async function changedBetween(top: string, from: string, to: string, files: readonly string[] | 'all'): Promise<Set<string>> {
  if (files.length === 0 || from === to) return new Set()
  const specs = files === 'all' ? [] : ['--', ...files.map(literal)]
  return new Set((await git(top, [...DIFF, '--no-renames', '--name-only', '-z', from, to, ...specs])).split('\0').filter(Boolean))
}

/**
 * Where each git folder's Session diff starts and ends. A waiting result is Confirm's
 * own record, the trees it compares at the click. Otherwise the working tree as a turn
 * snapshots it, measured from HEAD, or in a worktree from where its branch left the
 * branch its linked folder is on, so commits the Session already made still count.
 * In a shared checkout only this Session's files, the same set Confirm and a reached
 * goal take, because the checkout also holds other chats' work. A worktree is this
 * chat's alone, so everything in it counts, a commit or an edit made outside a turn too.
 * While a result waits, what that live scope holds beyond it is `excluded`.
 */
async function scopeOf(checkout: SessionCheckout): Promise<ScopedRepo[]> {
  const labels = folderLabels(checkout.repoPaths)
  const roots = await gitRoots(checkout.repoPaths)
  const absolute = (files: readonly string[]) => Promise.all(files.filter((file) => path.isAbsolute(file)).map(resolvedEntry))
  const measured = await absolute(checkout.sessionFiles)
  const liveMeasured = checkout.waiting === undefined || checkout.liveFiles === undefined ? undefined : await absolute(checkout.liveFiles)
  return Promise.all(roots.map(async (root): Promise<ScopedRepo> => {
    const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
    const label = labels[checkout.repoPaths.indexOf(root)] ?? path.basename(root)
    const head = await tryGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) ?? ''
    let mapping: ChatWorktree | undefined
    for (const row of checkout.mapping) if (await sameDir(row.worktreePath, root)) mapping = row
    const own = mapping === undefined ? {} : { mapping }
    if (checkout.waiting === undefined) return { root, top, label, head, ...await liveScope(top, head, mapping, inRepo(top, measured)), ...own }
    const waiting = checkout.waiting.repos.find((repo) => repo.path === top)
    const scoped: ScopedRepo = waiting === undefined
      ? { root, top, label, head, base: head, target: head, files: [], uncommitted: [], ...own }
      : {
          root, top, label, head, base: waiting.before === '' ? await emptyTree(top) : waiting.before, target: waiting.tree,
          files: waiting.files, uncommitted: [], ...own,
        }
    if (liveMeasured === undefined) return scoped
    const live = await liveScope(top, head, mapping, inRepo(top, liveMeasured))
    const excluded = live.files.filter((file) => !scoped.files.includes(file))
    return excluded.length === 0 ? scoped : { ...scoped, excluded: { base: live.base, target: live.target, files: excluded } }
  }))
}

/**
 * Of the paths a Session's turns recorded, the ones its live scope still holds:
 * committable, and changed from the Session's base or not yet committed. A file made
 * and removed again in a later turn, a reverted one and Git-ignored output drop out,
 * as does a relative name (an unmeasured ignored file). A path in no git folder stays,
 * since nothing measures it. Every file of `confirmed`, Confirm's own selection, stays
 * too: this list feeds Confirm again, which must never take less than it did.
 */
export async function liveSessionFiles(
  checkout: Pick<SessionCheckout, 'repoPaths' | 'mapping'>, recorded: readonly string[],
  confirmed: WorkCompletion['repos'] = [],
): Promise<string[]> {
  const absolute = [...new Set(recorded.filter((file) => path.isAbsolute(file)))]
  const entries = await Promise.all(absolute.map(resolvedEntry))
  // A linked folder may sit inside its repository, so each is measured from the top. A
  // repository holding none of the files is never snapshotted, as Confirm skips it too.
  const tops = await Promise.all(checkout.repoPaths.map((root) => tryGit(root, ['rev-parse', '--show-toplevel'])))
  const touched = [...new Set(tops)].filter((top): top is string =>
    top !== undefined && top.length > 0 && entries.some((entry) => inRepo(top, [entry]).length > 0))
  const scope = await scopeOf({ repoPaths: touched, mapping: checkout.mapping, sessionFiles: absolute })
  // Innermost folder first, so a nested repository answers for its own files.
  const repos = [...scope].sort((left, right) => right.top.length - left.top.length)
  return absolute.filter((_, at) => {
    const entry = entries[at] as string
    if (confirmed.some((repo) => repo.files.includes(path.relative(repo.path, entry)))) return true
    const repo = repos.find(({ top }) => inRepo(top, [entry]).length > 0)
    if (repo === undefined) return true
    const name = path.relative(repo.top, entry)
    return repo.files.includes(name) || repo.uncommitted.includes(name)
  })
}

/** Of these absolute paths, the ones inside this repository, repo-relative. */
const inRepo = (top: string, files: readonly string[]) => [...new Set(files.flatMap((file) => {
  const name = path.relative(top, file)
  return name.length > 0 && name !== '..' && !name.startsWith(`..${path.sep}`) && !path.isAbsolute(name) ? [name] : []
}))]

/**
 * The working tree as a turn snapshots it, measured from HEAD, or in a worktree from
 * where its branch left the branch its linked folder is on.
 */
async function liveScope(top: string, head: string, mapping: ChatWorktree | undefined, relative: readonly string[]): Promise<Pick<ScopedRepo, 'base' | 'target' | 'files' | 'uncommitted'>> {
  const from = head === '' ? await emptyTree(top) : head
  if (mapping === undefined && relative.length === 0) return { base: from, target: from, files: [], uncommitted: [] }
  const target = await captureTurnTree(top)
  let base = from
  if (mapping !== undefined && head !== '') {
    const home = await currentBranch(mapping.sourcePath)
    const forked = home === null ? undefined : await tryGit(top, ['merge-base', head, `refs/heads/${home}`])
    if (forked !== undefined && forked.length > 0) base = forked
  }
  const own = mapping === undefined ? relative : 'all'
  const inScope = await changedBetween(top, base, target, own)
  const dirty = await changedBetween(top, from, target, own)
  const listed = own === 'all' ? [...new Set([...inScope, ...dirty])] : own
  const allowed = await committable(top, head, listed)
  if (base !== from) for (const file of await committable(top, base, listed)) allowed.add(file)
  return {
    base, target,
    files: listed.filter((file) => allowed.has(file) && inScope.has(file)),
    uncommitted: listed.filter((file) => allowed.has(file) && dirty.has(file)),
  }
}

async function fileStats(top: string, from: string, to: string, files: readonly string[], ignoreWhitespace = false): Promise<SessionFileStat[]> {
  if (files.length === 0 || from === to) return []
  const range = [from, to, '--', ...files.map(literal)]
  const flags = [...DIFF, ...(ignoreWhitespace ? ['-w'] : []), '-z']
  const [numstat, names] = await Promise.all([git(top, [...flags, '--numstat', ...range]), git(top, [...flags, '--name-status', ...range])])
  const statuses = parseStatuses(names)
  return parseNumstat(numstat).map((file) => ({
    path: file.path,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    status: statuses.get(file.path) ?? 'edited',
    added: file.added,
    removed: file.removed,
  }))
}

/**
 * Where Push would go and how far ahead the branch is, from local refs only: no
 * fetch, so it never waits on the network. A tracked branch goes to its upstream; an
 * untracked one to `origin`, or the only remote, under its own name.
 */
async function pushTargetOf(top: string, branch: string): Promise<{ remote: string; remoteBranch: string; display: string; track: boolean; ahead: number } | undefined> {
  const remote = await tryGit(top, ['config', '--get', `branch.${branch}.remote`])
  const merge = await tryGit(top, ['config', '--get', `branch.${branch}.merge`])
  if (remote !== undefined && remote !== '.' && merge?.startsWith('refs/heads/') === true) {
    const tracking = await tryGit(top, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${merge.slice('refs/heads/'.length)}`])
    const remoteBranch = merge.slice('refs/heads/'.length)
    if (tracking !== undefined && tracking.length > 0) {
      const ahead = Number(await tryGit(top, ['rev-list', '--count', `${tracking}..HEAD`]) ?? 0)
      return { remote, remoteBranch, display: `${remote}/${remoteBranch}`, track: false, ahead }
    }
  }
  const remotes = (await tryGit(top, ['remote']) ?? '').split('\n').filter(Boolean)
  const chosen = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : undefined
  if (chosen === undefined) return undefined
  const ahead = Number(await tryGit(top, ['rev-list', '--count', 'HEAD', '--not', `--remotes=${chosen}`]) ?? 0)
  return { remote: chosen, remoteBranch: branch, display: chosen, track: true, ahead }
}

/**
 * What a remote URL says about its repository, for the panel: `owner/repo` and its web
 * page on a host with a domain name, the last path segment otherwise (a local bare
 * remote, an SSH alias). Built from host and path only, so a token or password in the
 * URL never reaches a client.
 */
export function repoRemote(url: string): { name: string; url?: string } | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return undefined
  // `git@host:owner/repo.git`, scp-style, which `URL` cannot read.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed)
  let host: string | undefined
  let repoPath: string
  if (scp !== null) {
    host = scp[1]
    repoPath = scp[2]!
  } else if (URL.canParse(trimmed)) {
    const parsed = new URL(trimmed)
    host = parsed.protocol === 'file:' ? undefined : parsed.hostname
    // Only the parsed path survives; a malformed escape drops the remote rather than
    // falling back to the raw URL, which may carry credentials.
    try {
      repoPath = decodeURIComponent(parsed.pathname)
    } catch {
      return undefined
    }
  } else if (trimmed.includes('://')) {
    return undefined
  } else {
    repoPath = trimmed
  }
  const segments = repoPath.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean)
  const last = segments.at(-1)
  if (last === undefined) return undefined
  if (host === undefined || !host.includes('.') || segments.length < 2) return { name: last }
  const name = segments.join('/')
  return { name, url: `https://${host}/${segments.map(encodeURIComponent).join('/')}` }
}

/** The repository a branch tracks (its upstream's remote, else `origin`, else the only one), named from that remote's fetch URL. */
async function remoteOf(top: string, branch: string | null): Promise<{ name: string; url?: string } | undefined> {
  const tracked = branch === null ? undefined : await tryGit(top, ['config', '--get', `branch.${branch}.remote`])
  const remotes = (await tryGit(top, ['remote']) ?? '').split('\n').filter(Boolean)
  const chosen = tracked !== undefined && remotes.includes(tracked) ? tracked
    : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined
  if (chosen === undefined) return undefined
  const url = await tryGit(top, ['remote', 'get-url', chosen])
  return url === undefined ? undefined : repoRemote(url)
}

export interface SessionStatus {
  changes: { files: number; added: number; removed: number }
  /** Present while a result waits and leaves some of the Session's changed files out. */
  excluded?: number
  repos: SessionRepo[]
}

/** The Session panel's Changes and Branch for every git folder of this checkout. */
export async function readSessionStatus(checkout: SessionCheckout): Promise<SessionStatus> {
  const scope = await scopeOf(checkout)
  const changes = { files: 0, added: 0, removed: 0 }
  const repos = await Promise.all(scope.map(async (repo): Promise<SessionRepo> => {
    const stats = await fileStats(repo.top, repo.base, repo.target, repo.files)
    changes.files += stats.length
    for (const file of stats) {
      changes.added += file.added
      changes.removed += file.removed
    }
    const uncommitted = repo.uncommitted.length === 0 ? [] : await fileStats(repo.top, repo.head === '' ? await emptyTree(repo.top) : repo.head, repo.target, repo.uncommitted)
    const branch = await currentBranch(repo.root)
    const mergeTarget = repo.mapping === undefined ? null : await currentBranch(repo.mapping.sourcePath)
    const push = branch === null || repo.head === '' ? undefined : await pushTargetOf(repo.top, branch)
    const remote = await remoteOf(repo.top, branch)
    return {
      root: repo.root,
      label: repo.label,
      branch,
      ...(mergeTarget === null ? {} : { mergeTarget }),
      ...(push === undefined ? {} : { pushTarget: push.display }),
      ahead: push?.ahead ?? 0,
      uncommitted: uncommitted.slice(0, MAX_SESSION_DIFF_FILES),
      ...(remote === undefined ? {} : { remote }),
    }
  }))
  const excluded = scope.reduce((count, repo) => count + (repo.excluded?.files.length ?? 0), 0)
  return { changes, ...(excluded === 0 ? {} : { excluded }), repos }
}

function parseHunks(section: string): { hunks: SessionDiffHunk[]; binary: boolean; clipped: boolean } {
  const hunks: SessionDiffHunk[] = []
  let current: SessionDiffHunk | undefined
  let clipped = false
  const lines = section.split('\n')
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header !== null) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] }
      hunks.push(current)
      continue
    }
    if (current === undefined) continue
    const sign = line[0]
    if (sign !== ' ' && sign !== '+' && sign !== '-') continue
    if (line.length > MAX_LINE_CHARS) {
      clipped = true
      current.lines.push(`${line.slice(0, MAX_LINE_CHARS)}…`)
    } else {
      current.lines.push(line)
    }
  }
  return { hunks, binary: hunks.length === 0 && /^Binary files /m.test(section), clipped }
}

export interface SessionDiff {
  files: SessionDiffFile[]
  partial: boolean
}

/**
 * The whole-Session diff, file by file. Hunks stop at `MAX_DIFF_LINES` changed lines
 * in all and `MAX_FILE_DIFF_LINES` in one file; past either a file keeps its counts
 * and says it was cut, and the diff says it is partial. While a result waits, the
 * Session's other changed files follow it, marked `excluded`.
 */
export async function readSessionDiff(checkout: SessionCheckout, ignoreWhitespace: boolean): Promise<SessionDiff> {
  const scope = await scopeOf(checkout)
  const files: SessionDiffFile[] = []
  let partial = false
  let budget = MAX_DIFF_LINES
  // One range of one folder: the result's own files, then, apart, those it leaves out.
  const add = async (repo: ScopedRepo, base: string, target: string, paths: readonly string[], excluded: boolean) => {
    const stats = await fileStats(repo.top, base, target, paths, ignoreWhitespace)
    const room = MAX_SESSION_DIFF_FILES - files.length
    if (stats.length > room) partial = true
    const listed = stats.slice(0, Math.max(0, room))
    const chosen = listed.filter((file) => {
      const size = file.added + file.removed
      if (size > MAX_FILE_DIFF_LINES || size > budget) return false
      budget -= size
      return true
    })
    const sections = new Map<string, string>()
    if (chosen.length > 0) {
      const specs = chosen.flatMap((file) => file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]).map(literal)
      const patch = await git(repo.top, [...DIFF, ...(ignoreWhitespace ? ['-w'] : []), '--unified=3', base, target, '--', ...specs], { maxBuffer: 96_000_000 })
      for (const section of patch.split(/^(?=diff --git )/m)) {
        const header = section.slice(0, section.indexOf('\n'))
        const file = chosen.find((candidate) => header === `diff --git a/${candidate.oldPath ?? candidate.path} b/${candidate.path}`)
        if (file !== undefined) sections.set(file.path, section)
      }
    }
    for (const file of listed) {
      const section = sections.get(file.path)
      const parsed = section === undefined ? undefined : parseHunks(section)
      const cut = section === undefined || parsed?.clipped === true
      if (section === undefined) partial = true
      files.push({
        ...file,
        root: repo.root,
        ...(isPreviewablePath(file.path) ? { panelPath: `${repo.label}/${file.path}` } : {}),
        ...(parsed?.binary === true ? { binary: true as const } : {}),
        hunks: parsed?.hunks ?? [],
        ...(cut && parsed?.binary !== true ? { truncated: true as const } : {}),
        ...(excluded ? { excluded: true as const } : {}),
      })
    }
  }
  for (const repo of scope) await add(repo, repo.base, repo.target, repo.files, false)
  for (const repo of scope) if (repo.excluded !== undefined) await add(repo, repo.excluded.base, repo.excluded.target, repo.excluded.files, true)
  return { files, partial }
}

/**
 * The uncommitted Session files of one folder, the only paths Commit may take there,
 * and each uncommitted rename's old path by its new one: Commit lists a rename as one
 * file, and lands both its sides.
 */
export async function commitCandidates(checkout: SessionCheckout, root: string): Promise<{ top: string; files: string[]; renamedFrom: Map<string, string> } | undefined> {
  const repo = (await scopeOf(checkout)).find((candidate) => candidate.root === root)
  if (repo === undefined) return undefined
  const stats = await fileStats(repo.top, repo.head === '' ? await emptyTree(repo.top) : repo.head, repo.target, repo.uncommitted)
  const renamedFrom = new Map(stats.flatMap((file) => file.oldPath === undefined ? [] : [[file.path, file.oldPath] as const]))
  return { top: repo.top, files: repo.uncommitted, renamedFrom }
}

/**
 * Commits exactly `files` from the working tree, and nothing else: `--only` takes
 * their current content and leaves whatever else is staged where it was. A new file
 * is first made known to Git with an intent-to-add entry, which a failed commit takes
 * back out of the index. Hooks run, as they would for the user in a terminal; the
 * pre-commit hook tests the packages the commit touches, so this may wait minutes.
 */
export async function commitFiles(top: string, files: readonly string[], message: string): Promise<string> {
  const specs = files.map(literal)
  const untracked = (await git(top, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs])).split('\0').filter(Boolean)
  if (untracked.length > 0) await git(top, ['add', '--intent-to-add', '--', ...untracked.map(literal)])
  const committed = await gitOutput(top, ['commit', '--quiet', '--only', '-m', message, '--', ...specs], 600_000)
  if (!committed.ok) {
    if (untracked.length > 0) await git(top, ['rm', '--cached', '--quiet', '--', ...untracked.map(literal)]).catch(() => undefined)
    const lines = committed.output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('hint:'))
    throw new SessionGitError(failingChecks(lines, 'commit') ?? lines.at(-1) ?? 'Git failed.', committed.output)
  }
  return (await git(top, ['rev-parse', 'HEAD'])).trim()
}

/** A plain message for a commit nobody wrote one for, when no model could. */
export function fallbackCommitMessage(files: readonly string[]): string {
  const names = files.map((file) => path.basename(file))
  if (names.length === 1) return `Update ${names[0]}`
  if (names.length === 2) return `Update ${names[0]} and ${names[1]}`
  return `Update ${names[0]} and ${names.length - 1} more files`
}

/** The patch a message writer reads, cut to a size a cheap model takes in one go. */
export async function commitPatch(top: string, files: readonly string[], limit = 12_000): Promise<string> {
  const head = await tryGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) ?? ''
  const tree = await captureTurnTree(top)
  const patch = await git(top, [...DIFF, '--unified=2', '--stat', '--patch', head === '' ? await emptyTree(top) : head, tree, '--', ...files.map(literal)], { maxBuffer: 32_000_000 })
  return patch.length > limit ? `${patch.slice(0, limit)}\n[diff cut]` : patch
}

/**
 * Names what a pre-commit or pre-push hook found when it stopped Git: the files
 * whose Vitest tests or TypeScript checks failed, as `pnpm -r` prefixes them. Undefined
 * when the output carries neither, so the caller falls back to Git's own words.
 */
export function failingChecks(lines: readonly string[], stopped: 'commit' | 'push'): string | undefined {
  const failing = new Set<string>()
  for (const raw of lines) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '')
    const test = /^(?:(\S+) test:\s+)?FAIL\s+(\S+)/.exec(line)
    const type = /^(?:(\S+) typecheck:\s+)?(\S+?)\(\d+,\d+\): error TS\d+/.exec(line)
    const hit = test ?? type
    if (hit !== null) failing.add(hit[1] === undefined ? hit[2]! : `${hit[1]} ${hit[2]}`)
  }
  if (failing.size === 0) return undefined
  const named = [...failing].slice(0, 3)
  const more = failing.size - named.length
  return `The pre-${stopped} check stopped the ${stopped}. Failing: ${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * Pushes the current branch, and only it, to where `pushTargetOf` points. The refspec
 * has no `+` and no force flag is ever passed, so the remote takes a fast-forward or
 * refuses. A branch with nothing ahead is refused before Git is asked.
 */
export async function pushBranch(root: string): Promise<string> {
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  const branch = await currentBranch(top)
  if (branch === null) throw new SessionGitError('This checkout is not on a branch, so there is nothing to push.')
  const target = await pushTargetOf(top, branch)
  if (target === undefined) throw new SessionGitError(`${branch} has no remote to push to.`)
  if (target.ahead === 0) throw new SessionGitError(`Nothing to push: ${branch} has no commits that ${target.display} lacks.`)
  const refspec = `refs/heads/${branch}:refs/heads/${target.remoteBranch}`
  // The repo's pre-push hook typechecks and tests the workspace first, so this waits on that too.
  const pushed = await gitOutput(top, ['push', '--porcelain', ...(target.track ? ['--set-upstream'] : []), target.remote, refspec], 600_000)
  const lines = pushed.output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  // Porcelain marks the ref `!` when the remote refused it, with the reason in brackets.
  const refused = lines.find((line) => line.startsWith('!') && line.includes(refspec))
  if (refused !== undefined) {
    throw new SessionGitError(`${target.remote} rejected the push (${/\(([^)]*)\)/.exec(refused)?.[1] ?? 'rejected'}).`)
  }
  if (!pushed.ok) {
    const checked = failingChecks(lines, 'push')
    if (checked !== undefined) throw new SessionGitError(checked)
    // "failed to push some refs" closes every refusal and never says why; the line before it does.
    const said = lines.filter((line) => !line.startsWith('hint:') && line !== 'Done' && !line.startsWith('To ') && !line.startsWith('error: failed to push some refs'))
    throw new SessionGitError(`Push failed: ${said.at(-1) ?? 'Git gave no reason.'}`)
  }
  return `Pushed ${plural(target.ahead, 'commit')} to ${target.remote}/${target.remoteBranch}.`
}
