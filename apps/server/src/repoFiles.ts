import { execFile } from 'node:child_process'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { MAX_REPO_FILE_BYTES, type FileWriteResult, type RepoFileResult } from '@manor/contracts'
import { readTextFile, replaceTextFile } from './fileIo.js'
import { gitBinary } from './gitBinary.js'

const run = promisify(execFile)

/**
 * How many paths one project may offer the composer. A menu is a picker, not an
 * index: past a few thousand entries the typing filter is doing all the work
 * anyway, and the whole list crosses the socket on every project open. Manor's own
 * checkout is about 4,000 paths once the verification screenshots are counted, so
 * the cap leaves room for those to grow.
 */
export const MAX_REPO_FILES = 8000

/** Folders no `@` menu should ever offer, for a folder that is not a git checkout. */
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.turbo'])

/** Files whose usual purpose is storing credentials, even when somebody tracked them by mistake. */
const SENSITIVE_FILES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'service-account.json',
])
const SENSITIVE_DIRS = new Set(['.aws', '.gnupg', '.kube', '.ssh'])

/** Keep temporary Git snapshots aligned with the Files panel's secret boundary. */
export function sensitiveGitPathspecExcludes(): string[] {
  return [
    ':(exclude,glob)**/.env',
    ':(exclude,glob)**/.env.*',
    ...[...SENSITIVE_FILES].map((name) => `:(exclude,glob)**/${name}`),
    ...[...SENSITIVE_DIRS].map((name) => `:(exclude,glob)**/${name}/**`),
  ]
}

export interface RepoFileListing {
  files: string[]
  /** The cap cut the list. The menu says so rather than implying it saw everything. */
  truncated: boolean
}

/**
 * The shortest readable suffix that uniquely identifies every linked folder.
 * Plain basenames stay plain; parent segments only appear for collisions.
 */
export function folderLabels(repoPaths: readonly string[]): string[] {
  const labels = repoPaths.map((root) => path.basename(root))
  const colliding = new Set(
    labels.filter((label, index) => labels.indexOf(label) !== index || labels.lastIndexOf(label) !== index),
  )
  if (colliding.size === 0) return labels

  for (const basename of colliding) {
    const indices = labels.flatMap((label, index) => (label === basename ? [index] : []))
    const segments = indices.map((index) => path.resolve(repoPaths[index]!).split(path.sep).filter(Boolean))
    const maxDepth = Math.max(...segments.map((parts) => parts.length))
    for (let depth = 2; depth <= maxDepth; depth += 1) {
      const candidates = segments.map((parts) => parts.slice(-depth).join('/'))
      if (new Set(candidates).size !== candidates.length) continue
      indices.forEach((index, offset) => {
        labels[index] = candidates[offset]!
      })
      break
    }
  }
  return labels
}

/**
 * Every mentionable file in a project's linked folders, as `<folder-name>/<path>`.
 *
 * The prefix is the folder's own basename when that is unique, because
 * this string is what the user reads in the composer and what the persona receives
 * verbatim; an absolute path would fill a chat bubble with `/Users/...` noise.
 * Collisions gain the shortest necessary parent suffix. `REPO_FILE_NOTE` tells the
 * persona to resolve it against the absolute folder list it already gets.
 *
 * `git ls-files` is the primary source because it is the gitignore the user actually
 * maintains: no walk of ours would agree with it, and disagreeing means offering to
 * mention `node_modules` or `.env`. The local-only folders in `LISTED_IGNORED_PREFIXES`
 * are the one exception, gitignore keeps them out of the repo and a second scoped
 * listing puts them back so the Files panel can open them. They only fill the room
 * the regular files leave, so a pile of screenshots never pushes source out of the
 * menu. A folder that is not a checkout gets a bounded walk with the crude skip list
 * above.
 */
export async function listRepoFiles(repoPaths: readonly string[]): Promise<RepoFileListing> {
  const labels = folderLabels(repoPaths)
  const byPath = (left: string, right: string) => left.localeCompare(right, 'en')
  const folders = await Promise.all(repoPaths.map(async (root) => {
    const found = (await gitFiles(root)) ?? { regular: await walk(root), ignored: [] }
    return {
      regular: found.regular.filter(isPreviewablePath).sort(byPath),
      ignored: found.ignored.filter(isPreviewablePath).sort(byPath),
      kept: [] as string[],
    }
  }))

  // Regular files of every folder claim the cap before any ignored file does, so
  // screenshots in the first folder never push a later folder's source out.
  let room = MAX_REPO_FILES
  let truncated = false
  for (const pick of ['regular', 'ignored'] as const) {
    for (const folder of folders) {
      const taken = folder[pick].slice(0, room)
      if (taken.length < folder[pick].length) truncated = true
      folder.kept.push(...taken)
      room -= taken.length
    }
  }

  // Sorted per folder, so the menu's order does not depend on whether git or the
  // walk produced it, nor on which listing a path came from.
  const files = folders.flatMap((folder, index) =>
    folder.kept.sort(byPath).map((relative) => `${labels[index]!}/${relative}`))
  return { files, truncated }
}

/**
 * Reads only a path the listing itself offered, with the content hash a later save
 * sends back as its precondition.
 */
export async function readRepoFile(repoPaths: readonly string[], requestedPath: string): Promise<RepoFileResult> {
  const target = await resolveInRepo(repoPaths, requestedPath)
  if (target === null) return unavailable()

  const read = await readTextFile(target)
  switch (read.kind) {
    case 'ready':
      return { status: 'ready', content: read.content, revision: read.revision }
    case 'too_large':
      return { status: 'too_large', size: read.size, maxSize: MAX_REPO_FILE_BYTES }
    case 'binary':
      return { status: 'binary', size: read.size }
    case 'missing':
      return unavailable()
  }
}

/**
 * Saves one file back to the folder it came from, refusing when what is on disk is
 * not what the editor read.
 *
 * That check is the whole point. A linked folder is a working repository: a persona
 * with a shell, an editor and a `git checkout` all write to it, and a plain write
 * would silently take the last writer's word for it. `stale` hands back what is
 * there now, so the client can offer to keep either side.
 *
 * There is no create branch, unlike the vault's. This resolves through the listing,
 * and a file that does not exist was never in one; a browser that can invent paths
 * in a git checkout is a worse thing to own than a browser that can only edit what
 * it showed you.
 */
export async function writeRepoFile(
  repoPaths: readonly string[],
  requestedPath: string,
  content: string,
  baseRevision: string,
): Promise<FileWriteResult> {
  const target = await resolveInRepo(repoPaths, requestedPath)
  if (target === null) {
    return { status: 'rejected', message: 'That file is not one of this project’s linked files.' }
  }

  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength > MAX_REPO_FILE_BYTES) {
    return {
      status: 'rejected',
      message: `A file is capped at ${MAX_REPO_FILE_BYTES} bytes and this one is ${bytes.byteLength}.`,
    }
  }

  const result = await replaceTextFile(target, bytes, baseRevision)
  switch (result.kind) {
    case 'saved':
      return { status: 'saved', revision: result.revision }
    case 'stale':
      return { status: 'stale', revision: result.revision, content: result.content }
    case 'missing':
      // Deliberately not a silent re-create: the file the editor was working on is
      // gone, and quietly resurrecting it hides that something deleted it.
      return { status: 'rejected', message: 'This file no longer exists on disk. Your text is still here.' }
    case 'unreadable':
      return { status: 'rejected', message: 'This file can no longer be read, so it will not be overwritten.' }
    case 'failed':
      return { status: 'rejected', message: 'That file could not be saved.' }
  }
}

/**
 * The absolute path behind a `<folder-label>/<path>` pointer, or null when the
 * listing never offered it.
 *
 * Membership of the listing is the guard, so `.gitignore` and the credential
 * deny-list are one policy for discovery, reads and writes alike, instead of
 * trusting the browser not to hand-craft a path the tree never showed. It costs a
 * `git ls-files` per request, which is the price of not having a second rule set
 * that can drift from the first.
 */
export async function resolveInRepo(repoPaths: readonly string[], requestedPath: string): Promise<string | null> {
  const listing = await listRepoFiles(repoPaths)
  if (!listing.files.includes(requestedPath)) return null

  const labels = folderLabels(repoPaths)
  const index = labels
    .map((label, rootIndex) => ({ label, rootIndex }))
    .sort((left, right) => right.label.length - left.label.length)
    .find(({ label }) => requestedPath.startsWith(`${label}/`))
  if (index === undefined) return null
  const relative = requestedPath.slice(index.label.length + 1)
  if (!isPreviewablePath(relative) || path.isAbsolute(relative) || relative.split('/').includes('..')) {
    return null
  }

  const root = repoPaths[index.rootIndex]
  if (root === undefined) return null
  try {
    const canonicalRoot = await realpath(root)
    const target = path.join(canonicalRoot, relative)
    // Linked roots are allowed, but a file or ancestor symlink must not redirect
    // a listed path to a different file, especially when handing it to another app.
    if (await realpath(target) !== target || !(await stat(target)).isFile()) return null
    return target
  } catch {
    return null
  }
}

export function isPreviewablePath(relative: string): boolean {
  const segments = relative.split('/')
  const basename = segments.at(-1)?.toLowerCase() ?? ''
  if (basename === '.env' || basename.startsWith('.env.')) return false
  if (SENSITIVE_FILES.has(basename)) return false
  return !segments.some((segment) => SENSITIVE_DIRS.has(segment.toLowerCase()))
}

const unavailable = (): RepoFileResult => ({
  status: 'unavailable',
  message: 'This file is not available to preview.',
})

/**
 * Gitignored folders the Files panel still lists: session working files under
 * `.claude/ideas` and `.claude/plans`, and the screenshots the verification skills
 * keep out of git. Anything else gitignore hides stays hidden.
 */
const LISTED_IGNORED_PREFIXES = [
  '.claude/ideas/',
  '.claude/plans/',
  '.cursor/skills/verify-manor/evidence/',
  '.cursor/skills/verify-manor-mobile/evidence/',
] as const

const isListedIgnoredFile = (relative: string): boolean =>
  LISTED_IGNORED_PREFIXES.some((prefix) => relative.startsWith(prefix))

/**
 * Tracked and untracked-but-not-ignored files as `regular`, and the gitignored
 * files under `LISTED_IGNORED_PREFIXES` as `ignored`. Null when the folder is not a
 * git checkout (or git is not installed, or the repo is broken). Null means "ask the
 * walker", never "this folder is empty": a silently empty menu reads as a project
 * with no files.
 */
async function gitFiles(root: string): Promise<{ regular: string[]; ignored: string[] } | null> {
  const [regular, extras] = await Promise.all([
    gitLsFiles(root, ['--cached', '--others', '--exclude-standard', '-z']),
    gitLsFiles(root, [
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
      '--',
      ...LISTED_IGNORED_PREFIXES.map((prefix) => prefix.slice(0, -1)),
    ]),
  ])
  if (regular === null) return null
  const seen = new Set(regular)
  const ignored = (extras ?? []).filter((relative) => isListedIgnoredFile(relative) && !seen.has(relative))
  return { regular, ignored }
}

async function gitLsFiles(root: string, args: readonly string[]): Promise<string[] | null> {
  try {
    const { stdout } = await run(
      gitBinary(),
      ['-C', root, 'ls-files', ...args],
      // A pathological repo must not hang the socket that asked, and the buffer is
      // sized for a listing far past MAX_REPO_FILES so a big repo truncates in our
      // code rather than dying on ENOBUFS.
      { timeout: 5_000, maxBuffer: 32 * 1024 * 1024 },
    )
    return stdout.split('\0').filter((entry) => entry.length > 0)
  } catch {
    return null
  }
}

/** Depth-first walk for a plain folder, capped so a linked home directory cannot hang. */
async function walk(root: string): Promise<string[]> {
  const found: string[] = []
  const queue = ['']

  while (queue.length > 0 && found.length < MAX_REPO_FILES) {
    const relative = queue.shift() as string
    let children
    try {
      children = await readdir(path.join(root, relative), { withFileTypes: true })
    } catch {
      // One unreadable folder is skipped, never fatal: a single EACCES deep in a
      // tree must not cost the whole listing.
      continue
    }
    for (const child of children) {
      if (child.name.startsWith('.') || SKIP.has(child.name)) continue
      const childPath = relative === '' ? child.name : `${relative}/${child.name}`
      if (child.isDirectory()) queue.push(childPath)
      else if (child.isFile()) found.push(childPath)
    }
  }

  return found
}
