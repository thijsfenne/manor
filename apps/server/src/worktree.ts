import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ChatWorktree } from './store.js'
import { gitBinary } from './gitBinary.js'

const run = promisify(execFile)

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }

/** Files copied into a fresh worktree when the repo has no `.worktreeinclude`. */
export const DEFAULT_WORKTREE_INCLUDES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
] as const

const NEVER_COPY = new Set([
  '.npmrc',
  '.claude',
  '.aws',
  '.gnupg',
  '.kube',
  '.ssh',
  '.netrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'service-account.json',
])

const DIRTY_REMOVE = 'That worktree has uncommitted changes. Discard it with force, or commit them first.'
const UNKNOWN_REMOVE =
  'Manor could not read that worktree, so it was not deleted. Discard it with force if the directory should go.'

/** Stable unique parent so two linked repos that share a basename do not collide on disk. */
export function sourceKey(sourcePath: string): string {
  return createHash('sha256').update(path.resolve(sourcePath)).digest('hex').slice(0, 8)
}

export function worktreeDir(
  worktreesRoot: string,
  projectId: string,
  chatId: string,
  sourcePath: string,
): string {
  return path.join(worktreesRoot, projectId, chatId, sourceKey(sourcePath), path.basename(sourcePath))
}

export function chatWorktreesDir(worktreesRoot: string, projectId: string, chatId: string): string {
  return path.join(worktreesRoot, projectId, chatId)
}

/** `manor/` plus eight hex characters of the chat id, hashed when the id is not hex. */
export function autoBranchName(chatId: string): string {
  const hex = chatId.replace(/-/g, '').replace(/[^0-9a-fA-F]/g, '')
  if (hex.length >= 8) return `manor/${hex.slice(0, 8).toLowerCase()}`
  return `manor/${createHash('sha256').update(chatId).digest('hex').slice(0, 8)}`
}

/**
 * The paths a turn, a files listing and project memory actually read. Empty mapping
 * is the project's own list. A mapped git folder is replaced; a non-git folder is
 * left as it is.
 */
export function effectiveRepoPaths(
  projectPaths: readonly string[],
  mapping: readonly ChatWorktree[],
): string[] {
  if (mapping.length === 0) return [...projectPaths]
  const bySource = new Map(mapping.map((row) => [row.sourcePath, row.worktreePath]))
  return projectPaths.map((source) => bySource.get(source) ?? source)
}

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  try {
    const { stdout } = await run(gitBinary(), args, { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { ok: true, stdout: stdout.trim() }
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string }
    return { ok: false, stderr: (err.stderr ?? err.message ?? String(error)).trim() }
  }
}

async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right))
  } catch {
    return path.resolve(left) === path.resolve(right)
  }
}

/** True when `dir` itself is a git work-tree root, not a folder inside one. */
export async function isGitRoot(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return false
  return samePath(result.stdout, dir)
}

export async function gitRoots(paths: readonly string[]): Promise<string[]> {
  const valid = await Promise.all(paths.map(isGitRoot))
  return paths.filter((_, index) => valid[index])
}

export async function currentBranch(dir: string): Promise<string | null> {
  const result = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!result.ok || result.stdout.length === 0 || result.stdout === 'HEAD') return null
  return result.stdout
}

const directoryBranches = new Map<string, { mtime: bigint; branch: Promise<string | null> }>()

/** Directory broadcasts only need another git process when this checkout's HEAD changes. */
export async function cachedCurrentBranch(dir: string): Promise<string | null> {
  const dotGit = path.join(dir, '.git')
  let head = path.join(dotGit, 'HEAD')
  try {
    if ((await stat(dotGit)).isFile()) {
      const match = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8'))
      if (!match) return currentBranch(dir)
      head = path.resolve(dir, match[1]!, 'HEAD')
    }
    const { mtimeNs } = await stat(head, { bigint: true })
    const cached = directoryBranches.get(head)
    if (cached?.mtime === mtimeNs) return cached.branch
    const branch = currentBranch(dir)
    directoryBranches.set(head, { mtime: mtimeNs, branch })
    return branch
  } catch {
    return currentBranch(dir)
  }
}

/**
 * What this isolated chat is actually on, read off disk. The stored mapping can
 * lag a `git switch` in the worktree (GitHub Desktop, a persona with a shell).
 * Unreadable or detached HEAD, or several git folders that disagree, is null:
 * never the stored name, which would lie.
 */
export async function liveWorktreeBranch(mapping: readonly ChatWorktree[]): Promise<string | null> {
  return sharedBranch(mapping.map((row) => row.worktreePath))
}

/** The one branch every folder is on; null when any is detached, unreadable or elsewhere. */
async function sharedBranch(dirs: readonly string[]): Promise<string | null> {
  if (dirs.length === 0) return null
  const names: (string | null)[] = []
  for (const dir of dirs) {
    names.push(await currentBranch(dir))
  }
  const live = names.filter((name): name is string => name !== null)
  if (live.length !== dirs.length) return null
  if (live.every((name) => name === live[0])) return live[0]!
  return null
}

/**
 * The commits on `dir`'s HEAD that `base` lacks, leaving out the full hashes in `except`,
 * one `<short hash> <subject>` per line, newest first. Null when git cannot tell, which
 * callers treat as not known clean.
 */
export async function commitsNotIn(dir: string, base: string, except: ReadonlySet<string> = new Set()): Promise<string[] | null> {
  const result = await git(dir, ['log', '--format=%H %h %s', `${base}..HEAD`])
  if (!result.ok) return null
  if (result.stdout.length === 0) return []
  return result.stdout.split('\n').filter((line) => !except.has(line.slice(0, line.indexOf(' ')))).map((line) => line.slice(line.indexOf(' ') + 1))
}

export type TreeStatus = 'missing' | 'clean' | 'dirty' | 'unknown'

/** Clean is only returned when `git status` succeeded and printed nothing. */
export async function treeStatus(dir: string): Promise<TreeStatus> {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return 'unknown'
  } catch {
    return 'missing'
  }
  const result = await git(dir, ['status', '--porcelain'])
  if (!result.ok) return 'unknown'
  return result.stdout.length > 0 ? 'dirty' : 'clean'
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  const result = await git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  return result.ok
}

async function listedWorktrees(source: string): Promise<{ dest: string; branch: string | null }[]> {
  const listed = await git(source, ['worktree', 'list', '--porcelain'])
  if (!listed.ok) return []
  const rows: { dest: string; branch: string | null }[] = []
  for (const block of listed.stdout.split('\n\n')) {
    const destLine = block.split('\n').find((line) => line.startsWith('worktree '))
    if (destLine === undefined) continue
    const branchLine = block.split('\n').find((line) => line.startsWith('branch '))
    const branch =
      branchLine === undefined ? null : branchLine.slice('branch '.length).replace(/^refs\/heads\//, '')
    rows.push({ dest: destLine.slice('worktree '.length), branch })
  }
  return rows
}

async function isLiveWorktree(source: string, dest: string): Promise<boolean> {
  for (const row of await listedWorktrees(source)) {
    if (await samePath(row.dest, dest)) return true
  }
  return false
}

async function listLocalBranches(dir: string): Promise<string[]> {
  const result = await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (!result.ok || result.stdout.length === 0) return []
  return result.stdout.split('\n').filter((name) => name.length > 0)
}

async function isAmong(dir: string, candidates: readonly string[]): Promise<boolean> {
  for (const candidate of candidates) {
    if (await samePath(dir, candidate)) return true
  }
  return false
}

/**
 * Local branches across the linked git folders, with availability already merged
 * into one list: the chat uses one branch name. Occupied in a foreign worktree
 * is a refusal. Occupied in a linked folder is `home`, still not a second
 * worktree, but the way back to that name. Missing from a live worktree is a
 * refusal only when switching.
 */
export async function listCheckoutBranches(
  roots: readonly string[],
  ours: readonly string[],
  mustExist: boolean,
): Promise<CheckoutBranch[]> {
  const perRoot = await Promise.all(
    roots.map(async (source) => ({
      source,
      local: new Set(await listLocalBranches(source)),
      worktrees: await listedWorktrees(source),
    })),
  )
  const names = new Set<string>()
  for (const row of perRoot) {
    for (const name of row.local) names.add(name)
  }

  const branches: CheckoutBranch[] = []
  for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
    let reason: string | undefined
    let home = false
    for (const row of perRoot) {
      for (const worktree of row.worktrees) {
        if (worktree.branch !== name) continue
        if (await isAmong(worktree.dest, ours)) continue
        reason = `already checked out in ${path.basename(worktree.dest)}`
        home = await isAmong(worktree.dest, [row.source])
        break
      }
      if (reason !== undefined) break
      if (mustExist && !row.local.has(name)) {
        reason = `does not exist in ${path.basename(row.source)}`
        break
      }
    }
    if (reason === undefined) {
      branches.push({ name, available: true })
    } else if (home) {
      branches.push({ name, available: false, reason, home: true })
    } else {
      branches.push({ name, available: false, reason })
    }
  }
  return branches
}

async function destExists(dest: string): Promise<boolean> {
  try {
    const info = await stat(dest)
    return info.isDirectory()
  } catch {
    return false
  }
}

async function sourceOfWorktree(dest: string): Promise<string | undefined> {
  const common = await git(dest, ['rev-parse', '--git-common-dir'])
  if (!common.ok || common.stdout.length === 0) return undefined
  return path.resolve(dest, common.stdout, '..')
}

export type WorktreeSwitch = { dest: string; previous: string }

export type WorktreeResult =
  | {
      ok: true
      mapping: ChatWorktree[]
      created: ChatWorktree[]
      /** Leftovers this call `git switch`'d. Persist failure must switch them back. */
      switched: WorktreeSwitch[]
      notices: string[]
    }
  | { ok: false; message: string }

export interface AttachWorktreesInput {
  worktreesRoot: string
  projectId: string
  chatId: string
  repoPaths: readonly string[]
  /** Omitted: auto name on create, leftover's own branch on resume. */
  branch?: string
}

/**
 * Isolate this chat onto worktrees of every git-linked folder.
 *
 * A live leftover is reused. If the request named a different branch than the
 * leftover actually has, Manor tries `git switch` there, or refuses: it never
 * writes a mapping for the leftover's old branch while a different name was asked.
 * A missing or broken leftover is created from the source HEAD, after a clean
 * leftover directory is removed. A dirty or unreadable leftover is a refusal.
 */
export async function attachWorktrees(input: AttachWorktreesInput): Promise<WorktreeResult> {
  const roots = await gitRoots(input.repoPaths)
  if (roots.length === 0) {
    return { ok: false, message: 'This project has no git folder to isolate.' }
  }

  const wanted = input.branch?.trim()
  const leftovers = await Promise.all(
    roots.map(async (source) => {
      const dest = worktreeDir(input.worktreesRoot, input.projectId, input.chatId, source)
      return { source, dest, live: await isLiveWorktree(source, dest) }
    }),
  )

  for (const leftover of leftovers) {
    if (leftover.live) continue
    if (!(await destExists(leftover.dest))) continue
    const removed = await removeWorktree(leftover.source, leftover.dest)
    if (!removed.ok) return { ok: false, message: removed.message }
  }

  const live = leftovers.filter((entry) => entry.live)
  const missing = leftovers.filter((entry) => !entry.live)
  if (live.length > 0) {
    const previous = await Promise.all(
      live.map(async (entry) => ({
        ...entry,
        branch: await currentBranch(entry.dest),
      })),
    )
    const actual = previous[0]?.branch ?? null
    let switched: WorktreeSwitch[] = []
    if (wanted !== undefined && wanted.length > 0) {
      const changed = await switchLeftovers(previous, wanted)
      if (!changed.ok) return changed
      switched = changed.switched
    }
    const branch = wanted !== undefined && wanted.length > 0 ? wanted : actual
    if (branch === null || branch.length === 0) {
      return { ok: false, message: 'That leftover worktree has no branch to resume.' }
    }
    // A resumed leftover merges back into what its linked folder holds now, as a new one would.
    const resumed = async (createdAt: number) => Promise.all(live.map(async (entry) => {
      const base = await currentBranch(entry.source)
      return { sourcePath: entry.source, worktreePath: entry.dest, branch, createdAt, ...(base === null ? {} : { baseBranch: base }) }
    }))
    if (missing.length === 0) {
      return {
        ok: true,
        mapping: await resumed(Date.now()),
        created: [],
        switched,
        notices: [],
      }
    }
    const created = await createWorktrees({ ...input, branch }, missing.map((entry) => entry.source), branch)
    if (!created.ok) {
      await revertSwitches(switched)
      return created
    }
    return {
      ok: true,
      mapping: [...await resumed(Date.now()), ...created.mapping],
      created: created.created,
      switched,
      notices: created.notices,
    }
  }

  return createWorktrees(input, roots, wanted)
}

async function canSwitchLeftover(
  dest: string,
  source: string,
  wanted: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const status = await treeStatus(dest)
  if (status === 'dirty' || status === 'unknown') {
    return {
      ok: false,
      message:
        status === 'unknown'
          ? `Manor could not read the leftover worktree, so it cannot switch it to ${wanted}.`
          : `The leftover worktree has uncommitted changes, so Manor cannot switch it to ${wanted}. Discard it first, or stay on the leftover's current branch.`,
    }
  }
  if (!(await branchExists(source, wanted))) {
    return {
      ok: false,
      message: `The leftover worktree is not on ${wanted}, and that branch does not exist. Discard the leftover first to isolate onto a new branch, or resume the leftover as it is.`,
    }
  }
  return { ok: true }
}

async function switchLeftovers(
  live: readonly { dest: string; source: string; branch: string | null }[],
  wanted: string,
): Promise<{ ok: true; switched: WorktreeSwitch[] } | { ok: false; message: string }> {
  const needs = live.filter((entry) => entry.branch !== wanted)
  for (const leftover of needs) {
    const ready = await canSwitchLeftover(leftover.dest, leftover.source, wanted)
    if (!ready.ok) return ready
  }
  const switched: WorktreeSwitch[] = []
  for (const leftover of needs) {
    const result = await git(leftover.dest, ['switch', '--quiet', wanted])
    if (!result.ok) {
      await revertSwitches(switched)
      return { ok: false, message: gitRefusal(result.stderr, wanted) }
    }
    if (leftover.branch !== null) switched.push({ dest: leftover.dest, previous: leftover.branch })
  }
  return { ok: true, switched }
}

/** Best-effort undo of `git switch` after a persist failure. */
export async function revertSwitches(switched: readonly WorktreeSwitch[]): Promise<void> {
  for (const row of [...switched].reverse()) {
    await git(row.dest, ['switch', '--quiet', row.previous])
  }
}

async function createWorktrees(
  input: AttachWorktreesInput,
  roots: readonly string[],
  wanted: string | undefined,
): Promise<WorktreeResult> {
  const branch = wanted !== undefined && wanted.length > 0 ? wanted : autoBranchName(input.chatId)
  const notices: string[] = []
  const mapping: ChatWorktree[] = []
  const createdAt = Date.now()
  let dirtySource = false

  try {
    for (const source of roots) {
      if ((await treeStatus(source)) === 'dirty') dirtySource = true
      const dest = worktreeDir(input.worktreesRoot, input.projectId, input.chatId, source)
      await mkdir(path.dirname(dest), { recursive: true })
      const base = await currentBranch(source)
      const added = await addWorktree(source, dest, branch)
      if (!added.ok) {
        await rollback(mapping)
        return added
      }
      mapping.push({ sourcePath: source, worktreePath: dest, branch, createdAt, ...(base === null ? {} : { baseBranch: base }) })
      await copyIncludes(source, dest)
    }
  } catch (error: unknown) {
    await rollback(mapping)
    const why = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Manor could not finish the worktree: ${why}` }
  }

  if (dirtySource) {
    notices.push(
      'Uncommitted edits in the linked folders did not come along. The worktree started from HEAD.',
    )
  }
  return { ok: true, mapping, created: mapping, switched: [], notices }
}

async function addWorktree(source: string, dest: string, branch: string, startPoint?: string): Promise<WorktreeResult | { ok: true }> {
  const exists = await branchExists(source, branch)
  const args = exists
    ? ['worktree', 'add', '--quiet', dest, branch]
    : ['worktree', 'add', '--quiet', '-b', branch, dest, ...(startPoint === undefined ? [] : [startPoint])]
  const added = await git(source, args)
  if (added.ok) return { ok: true }
  return { ok: false, message: gitRefusal(added.stderr, branch) }
}

function gitRefusal(stderr: string, branch: string): string {
  const text = stderr.replace(/\s+/g, ' ').trim()
  if (/already used by worktree|already checked out/i.test(text)) {
    return `${branch} is already checked out in another copy. Stay on the current checkout, or pick a new branch name.`
  }
  if (text.length === 0) return `Manor could not create a worktree for ${branch}.`
  return text
}

async function rollback(mapping: readonly ChatWorktree[]): Promise<void> {
  for (const row of mapping) {
    await removeWorktree(row.sourcePath, row.worktreePath, { force: true })
  }
}

export async function copyIncludes(source: string, dest: string): Promise<void> {
  const listed = await filesMatchingInclude(source)
  for (const relative of listed) {
    const base = path.basename(relative)
    if (NEVER_COPY.has(base) || NEVER_COPY.has(relative.split('/')[0] ?? '')) continue
    const from = path.join(source, relative)
    const to = path.join(dest, relative)
    const info = await stat(from).catch(() => undefined)
    if (info === undefined || !info.isFile()) continue
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to)
  }
}

/**
 * `.worktreeinclude` is gitignore syntax (Claude Code's format), not a list of
 * literal paths. Expand it against untracked gitignored files so a pattern like
 * `config/*.local.json` actually copies. Tracked files are already in the
 * worktree; unignored untracked files stay behind on purpose.
 */
async function filesMatchingInclude(source: string): Promise<string[]> {
  const includeFile = path.join(source, '.worktreeinclude')
  const hasFile = await stat(includeFile).then((info) => info.isFile()).catch(() => false)
  let spec = includeFile
  let cleanup: string | undefined
  if (!hasFile) {
    cleanup = path.join(os.tmpdir(), `manor-wt-inc-${process.pid}-${Date.now()}`)
    await writeFile(cleanup, `${[...DEFAULT_WORKTREE_INCLUDES].join('\n')}\n`)
    spec = cleanup
  }
  try {
    const matching = await git(source, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${spec}`])
    const ignored = await git(source, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])
    const ignoredSet = new Set((ignored.ok ? ignored.stdout : '').split('\0').filter((name) => name.length > 0))
    return (matching.ok ? matching.stdout : '')
      .split('\0')
      .filter((name) => name.length > 0 && ignoredSet.has(name))
  } finally {
    if (cleanup !== undefined) await rm(cleanup).catch(() => undefined)
  }
}

export type RemoveResult = { ok: true } | { ok: false; dirty: boolean; message: string }

/**
 * The one way a worktree directory leaves disk. Clean must be positively
 * established, or the caller must pass `{ force: true }`. A failed `git status`
 * is unknown, never clean.
 */
export async function removeWorktree(
  sourcePath: string | undefined,
  worktreePath: string,
  options: { force?: boolean } = {},
): Promise<RemoveResult> {
  const force = options.force === true
  const status = await treeStatus(worktreePath)
  const source = sourcePath ?? (status === 'missing' ? undefined : await sourceOfWorktree(worktreePath))
  const live = source !== undefined && (await isLiveWorktree(source, worktreePath))

  if (status === 'missing' && !live) return { ok: true }

  if (!force && status !== 'clean' && status !== 'missing') {
    return {
      ok: false,
      dirty: status === 'dirty',
      message: status === 'unknown' ? UNKNOWN_REMOVE : DIRTY_REMOVE,
    }
  }

  if (status === 'missing' && live && source !== undefined) {
    await git(source, ['worktree', 'prune'])
    return { ok: true }
  }

  if (source !== undefined) {
    const args = force
      ? ['worktree', 'remove', '--force', worktreePath]
      : ['worktree', 'remove', worktreePath]
    const removed = await git(source, args)
    if (removed.ok) {
      await rmIfPresent(worktreePath)
      return { ok: true }
    }
    if (!force && /contains modified or untracked files/i.test(removed.stderr)) {
      return { ok: false, dirty: true, message: DIRTY_REMOVE }
    }
    if (!force && status !== 'clean') {
      return { ok: false, dirty: false, message: UNKNOWN_REMOVE }
    }
  } else if (!force && status !== 'clean') {
    return {
      ok: false,
      dirty: status === 'dirty',
      message: status === 'unknown' ? UNKNOWN_REMOVE : DIRTY_REMOVE,
    }
  }

  await rmIfPresent(worktreePath)
  if (source !== undefined) await git(source, ['worktree', 'prune'])
  return { ok: true }
}

async function rmIfPresent(worktreePath: string): Promise<void> {
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
  const parent = path.dirname(worktreePath)
  const leftover = await readdir(parent).catch(() => ['x'])
  if (leftover.length === 0) await rm(parent, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Inspect every tree before removing any, so a dirty second repo cannot leave the
 * first already gone.
 */
export async function removeWorktrees(
  rows: readonly { sourcePath: string; worktreePath: string }[],
  options: { force?: boolean } = {},
): Promise<RemoveResult> {
  if (options.force !== true) {
    for (const row of rows) {
      const status = await treeStatus(row.worktreePath)
      if (status === 'dirty' || status === 'unknown') {
        return {
          ok: false,
          dirty: status === 'dirty',
          message: status === 'unknown' ? UNKNOWN_REMOVE : DIRTY_REMOVE,
        }
      }
    }
  }
  for (const row of rows) {
    const removed = await removeWorktree(row.sourcePath, row.worktreePath, options)
    if (!removed.ok) return removed
  }
  return { ok: true }
}

export interface CheckoutBranch {
  name: string
  available: boolean
  reason?: string
  home?: boolean
}

export interface CheckoutStatus {
  mode: 'current' | 'worktree'
  branch: string | null
  dirty: boolean
  gitRoots: string[]
  leftover?: { branch: string; dirty: boolean }
  branches: CheckoutBranch[]
  /** Worktree mode only: the branch every linked folder is on, when they agree. */
  homeBranch?: string
}

function dirtyOrUnknown(status: TreeStatus): boolean {
  return status === 'dirty' || status === 'unknown'
}

/** Live worktrees at this chat's deterministic paths, even when the mapping is empty. */
export async function listLeftovers(input: {
  worktreesRoot: string
  projectId: string
  chatId: string
  repoPaths: readonly string[]
}): Promise<ChatWorktree[]> {
  const roots = await gitRoots(input.repoPaths)
  const rows: ChatWorktree[] = []
  for (const source of roots) {
    const dest = worktreeDir(input.worktreesRoot, input.projectId, input.chatId, source)
    if (!(await destExists(dest)) && !(await isLiveWorktree(source, dest))) continue
    const branch = (await currentBranch(dest)) ?? ''
    rows.push({ sourcePath: source, worktreePath: dest, branch, createdAt: 0 })
  }
  return rows
}

export async function readCheckoutStatus(input: {
  repoPaths: readonly string[]
  mapping: readonly ChatWorktree[]
  worktreesRoot: string
  projectId: string
  /** Omit on the new-chat stage: leftovers hang off a chat id, and there is none yet. */
  chatId?: string
}): Promise<CheckoutStatus> {
  const roots = await gitRoots(input.repoPaths)
  const leftoverRows =
    input.mapping.length > 0 || input.chatId === undefined
      ? []
      : await listLeftovers({
          worktreesRoot: input.worktreesRoot,
          projectId: input.projectId,
          chatId: input.chatId,
          repoPaths: input.repoPaths,
        })
  const leftover = await leftoverOf(leftoverRows)
  const ours =
    input.mapping.length > 0
      ? input.mapping.map((row) => row.worktreePath)
      : leftoverRows.map((row) => row.worktreePath)
  const branches = await listCheckoutBranches(roots, ours, input.mapping.length > 0)
  if (input.mapping.length > 0) {
    const homeBranch = await sharedBranch(input.mapping.map((row) => row.sourcePath))
    return {
      mode: 'worktree',
      branch: await liveWorktreeBranch(input.mapping),
      dirty: await anyDirty(input.mapping.map((row) => row.worktreePath)),
      gitRoots: roots,
      branches,
      ...(homeBranch === null ? {} : { homeBranch }),
    }
  }
  return {
    mode: 'current',
    branch: roots[0] === undefined ? null : await currentBranch(roots[0]),
    dirty: await anyDirty(roots),
    gitRoots: roots,
    branches,
    ...(leftover === undefined ? {} : { leftover }),
  }
}

async function leftoverOf(
  rows: readonly ChatWorktree[],
): Promise<{ branch: string; dirty: boolean } | undefined> {
  if (rows.length === 0) return undefined
  const named = rows.map((row) => row.branch).find((name) => name.length > 0)
  if (named === undefined) return undefined
  return { branch: named, dirty: await anyDirty(rows.map((row) => row.worktreePath)) }
}

async function anyDirty(paths: readonly string[]): Promise<boolean> {
  for (const dir of paths) {
    if (dirtyOrUnknown(await treeStatus(dir))) return true
  }
  return false
}

async function listCandidateDirs(chatDir: string): Promise<string[]> {
  const found: string[] = []
  const first = await readdir(chatDir, { withFileTypes: true }).catch(() => [])
  for (const entry of first) {
    if (!entry.isDirectory()) continue
    const dir = path.join(chatDir, entry.name)
    const nested = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const children = nested.filter((child) => child.isDirectory())
    if (children.length === 0) {
      found.push(dir)
      continue
    }
    for (const child of children) found.push(path.join(dir, child.name))
  }
  return found
}

/**
 * Drops every `node_modules` directory under a worktree checkout. Walks past
 * `.git` and does not follow the directory it is about to delete. Missing
 * roots are an ordinary zero.
 */
async function pruneNodeModules(root: string): Promise<number> {
  let removed = 0
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === '.git') continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const target = path.join(root, entry.name)
    if (entry.name === 'node_modules') {
      await rm(target, { recursive: true, force: true })
      removed += 1
      continue
    }
    if (entry.isDirectory()) removed += await pruneNodeModules(target)
  }
  return removed
}

/**
 * Strips `node_modules` from one chat's worktrees. The checkout stays.
 * Missing paths are an ordinary zero. Callers that race a turn must hold
 * that chat's queue around this, the same reserve checkout uses.
 */
export async function pruneWorktreeNodeModules(input: {
  worktreesRoot: string
  projectId: string
  chatId: string
}): Promise<number> {
  const chatDir = chatWorktreesDir(input.worktreesRoot, input.projectId, input.chatId)
  let removed = 0
  for (const dest of await listCandidateDirs(chatDir)) {
    removed += await pruneNodeModules(dest)
  }
  return removed
}

/**
 * True only when git says `branch`'s tip is in `base`, the branch the worktree was
 * created from (main for rows that predate recording it): the ancestry rule Confirm trusts.
 */
export async function branchInBase(source: string, branch: string, base: string): Promise<boolean> {
  return (await git(source, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${base}`])).ok
}

/** The branch a worktree row merges back into. */
export const worktreeBase = (row: Pick<ChatWorktree, 'baseBranch'>): string => row.baseBranch ?? 'main'

/**
 * Deletes a Session's own `manor/<hex>` branch once its folder is gone and its tip is
 * in the base. The ref is compared to the tip read here, so a commit landing meanwhile
 * keeps it; one still checked out elsewhere stays. Other branch names are the user's.
 */
async function dropSessionBranch(source: string, branch: string, base: string): Promise<boolean> {
  if (!/^manor\/[0-9a-f]{8}$/.test(branch)) return false
  if ((await listedWorktrees(source)).some((row) => row.branch === branch)) return false
  const tip = await git(source, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  if (!tip.ok || !(await git(source, ['merge-base', '--is-ancestor', tip.stdout, `refs/heads/${base}`])).ok) return false
  return (await git(source, ['update-ref', '-d', `refs/heads/${branch}`, tip.stdout])).ok
}

export type ReleaseResult = { ok: true; removed: number } | { ok: false; reason: string }

/**
 * Takes a closed chat's worktree folders off disk once every one is a registered,
 * clean worktree on a branch already in its base (`worktreeBase`). Ignored files such as `node_modules`
 * do not count as changes; edits hidden by `assume-unchanged` or `skip-worktree`
 * would not show either, so any such entry keeps the folder. All folders are
 * inspected before any is removed. `beforeRemove` then receives the mapping with
 * each folder's live branch, to save it so `restoreWorktrees` brings the folder back
 * on the name it actually had; it returns false to keep everything. Any git refusal
 * keeps the folder: there is no forced or plain `rm` fallback here. A removed folder's
 * own `manor/<hex>` branch goes too; a restore recreates it from that base.
 */
export async function releaseMergedWorktrees(
  mapping: readonly ChatWorktree[],
  beforeRemove: (live: ChatWorktree[]) => Promise<boolean>,
): Promise<ReleaseResult> {
  const present: ChatWorktree[] = []
  const live: ChatWorktree[] = []
  for (const row of mapping) {
    if (!(await destExists(row.worktreePath))) {
      // An earlier release took the folder but Git refused the branch (a ref lock); try again.
      await dropSessionBranch(row.sourcePath, row.branch, worktreeBase(row))
      live.push(row)
      continue
    }
    // Explicit, so a repo-local `status.showUntrackedFiles=no` cannot hide new files.
    const status = await git(row.worktreePath, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'])
    if (!status.ok) return { ok: false, reason: 'unreadable checkout' }
    if (status.stdout.length > 0) return { ok: false, reason: 'uncommitted changes' }
    if (!(await isLiveWorktree(row.sourcePath, row.worktreePath))) return { ok: false, reason: 'not a registered worktree' }
    if (await hidesIndexEntries(row.worktreePath)) return { ok: false, reason: 'index entries hidden from status' }
    // Git refuses to remove these, and a submodule's own config can hide its untracked files.
    if (await stat(path.join(row.worktreePath, '.gitmodules')).then(() => true, () => false)) return { ok: false, reason: 'contains submodules' }
    const branch = await currentBranch(row.worktreePath)
    if (branch === null) return { ok: false, reason: 'detached HEAD' }
    const base = worktreeBase(row)
    if (!(await branchInBase(row.sourcePath, branch, base))) return { ok: false, reason: `${branch} is not in ${base}` }
    present.push(row)
    live.push({ ...row, branch })
  }
  if (present.length === 0) return { ok: true, removed: 0 }
  if (!(await beforeRemove(live))) return { ok: false, reason: 'kept by the caller' }
  let removed = 0
  for (const row of present) {
    const result = await git(row.sourcePath, ['-c', 'status.showUntrackedFiles=all', 'worktree', 'remove', row.worktreePath])
    if (!result.ok) return { ok: false, reason: result.stderr }
    await rmIfPresent(row.worktreePath)
    removed += 1
    const branch = live.find((entry) => entry.worktreePath === row.worktreePath)?.branch ?? row.branch
    await dropSessionBranch(row.sourcePath, branch, worktreeBase(row))
  }
  return { ok: true, removed }
}

/** Lowercase tags are `assume-unchanged`, `S` is `skip-worktree`; unreadable counts as hiding. */
async function hidesIndexEntries(dir: string): Promise<boolean> {
  const listed = await git(dir, ['ls-files', '-v'])
  if (!listed.ok) return true
  return listed.stdout.split('\n').some((line) => /^[a-zS] /.test(line))
}

/** A mapped folder left disk, as a released Session's does until its next turn or reopen. */
export async function anyWorktreeMissing(mapping: readonly ChatWorktree[]): Promise<boolean> {
  for (const row of mapping) {
    if (!(await destExists(row.worktreePath))) return true
  }
  return false
}

/**
 * Puts back a mapped worktree folder that left disk, on the same path and its kept
 * branch. A branch that is gone was dropped once it sat in its base, so it comes back
 * from that base (`worktreeBase`), not from whatever the linked folder has checked out;
 * only a base that no longer exists falls back to the source HEAD. A released Session
 * gets its folder back here at its next turn or reopen.
 */
export async function restoreWorktrees(
  mapping: readonly ChatWorktree[],
): Promise<{ ok: true; restored: number } | { ok: false; message: string }> {
  let restored = 0
  for (const row of mapping) {
    if (await destExists(row.worktreePath)) continue
    // A source that is gone or no longer a repo cannot restore anything; the turn runs as before.
    if (!(await isGitRoot(row.sourcePath))) continue
    await git(row.sourcePath, ['worktree', 'prune'])
    await mkdir(path.dirname(row.worktreePath), { recursive: true })
    const base = `refs/heads/${worktreeBase(row)}`
    const baseExists = (await git(row.sourcePath, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).ok
    const added = await addWorktree(row.sourcePath, row.worktreePath, row.branch, baseExists ? base : undefined)
    if (!added.ok) {
      return { ok: false, message: `Manor could not restore the ${path.basename(row.sourcePath)} worktree: ${added.message}` }
    }
    await copyIncludes(row.sourcePath, row.worktreePath)
    restored += 1
  }
  return { ok: true, restored }
}

/**
 * Removes a clean directory that belongs to no chat, and prunes broken git
 * registrations. A leftover of a living chat stays. Dirty and unreadable orphans stay.
 */
export async function sweepWorktrees(options: {
  worktreesRoot: string
  liveChatIds: readonly string[]
}): Promise<{ directoriesRemoved: number }> {
  const live = new Set(options.liveChatIds)
  let directoriesRemoved = 0
  const projects = await readdir(options.worktreesRoot, { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(options.worktreesRoot, project.name)
    const chats = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
    for (const chat of chats) {
      if (!chat.isDirectory()) continue
      if (live.has(chat.name)) continue
      const chatDir = path.join(projectDir, chat.name)
      let remaining = 0
      for (const dest of await listCandidateDirs(chatDir)) {
        remaining += 1
        const removed = await removeWorktree(undefined, dest)
        if (!removed.ok) continue
        directoriesRemoved += 1
        remaining -= 1
      }
      if (remaining === 0) await rm(chatDir, { recursive: true, force: true }).catch(() => undefined)
    }
    const leftover = await readdir(projectDir).catch(() => ['x'])
    if (leftover.length === 0) await rm(projectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  return { directoriesRemoved }
}

export async function removeProjectWorktrees(worktreesRoot: string, projectId: string): Promise<void> {
  const projectDir = path.join(worktreesRoot, projectId)
  const chats = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
  for (const chat of chats) {
    if (!chat.isDirectory()) continue
    const chatDir = path.join(projectDir, chat.name)
    for (const dest of await listCandidateDirs(chatDir)) {
      await removeWorktree(undefined, dest)
    }
  }
  const leftover = await readdir(projectDir).catch(() => ['x'])
  if (leftover.length === 0) await rm(projectDir, { recursive: true, force: true }).catch(() => undefined)
}
