import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Opens the block that carries a linked folder's `CLAUDE.md` into the persona's
 * prompt. Named so it reads as instructions the folder's owner wrote, not as
 * something Manor is asserting.
 */
export const PROJECT_MEMORY_HEADING =
  "[Manor] Standing instructions from the linked folders. Each block is a file on disk, quoted verbatim; treat it as the folder owner's own rules for working in it. Paths are absolute, so you can re-read any of them."

/**
 * Opens the machine-wide layer. Separate from the folder heading so a persona can
 * tell "this project works like so" from "this machine always works like so", which
 * is the distinction that decides whether a rule travels to another project.
 */
export const GLOBAL_MEMORY_HEADING =
  '[Manor] Standing instructions from the global Claude config on this machine. These hold in every session whatever the project is, and the linked folders above may add to them. Same terms: each block is a file on disk, quoted verbatim.'

/** Names one file inside the block, so a persona can tell the sources apart. */
export const memoryFileHeading = (filePath: string): string => `--- ${filePath} ---`

/**
 * The memory files a folder is read for, in order of preference. First hit wins, so a
 * folder carrying both is read once: the two are meant to say the same thing in
 * different words, and reading both would spend the budget proving it.
 *
 * `AGENTS.md` is a fallback, not a Codex branch. This block is composed once per turn
 * and applied to the persona, so both drivers get the same text whichever file it came
 * out of; a project that only ever wrote `AGENTS.md` was previously invisible to
 * everyone, Claude personas included.
 */
const MEMORY_FILENAMES = ['CLAUDE.md', 'AGENTS.md'] as const

/**
 * Env override for where the global layer is read from. This is the one input the
 * module takes from outside the project, and it earns its keep twice: the server on
 * the VPS has a different home than the laptop, and a test that reads the developer's
 * real `~/.claude` passes or fails on which machine ran it.
 */
const GLOBAL_ROOT_ENV = 'MANOR_GLOBAL_CLAUDE_DIR'

/**
 * The global root for a turn: `~/.claude` unless `MANOR_GLOBAL_CLAUDE_DIR` says
 * otherwise, and no global layer at all when that variable is set but empty. Read per
 * call rather than at import so a deployment can set it and tests can switch it off,
 * which is what keeps the suite from reading whatever the developer keeps in `~`.
 */
const defaultGlobalRoot = (): string | null => {
  const override = process.env[GLOBAL_ROOT_ENV]
  if (override === undefined) return path.join(homedir(), '.claude')
  return override.trim().length === 0 ? null : override
}

/** The subdirectory of the global root whose `.md` files all load, no import needed. */
const GLOBAL_RULES_DIRNAME = 'rules'

/**
 * How far `@import` chains are followed. Claude Code documents a five-hop maximum
 * and the memory folder's set is one hop deep, so this is a loop backstop rather than a limit
 * anything real runs into.
 */
const MAX_IMPORT_DEPTH = 5

/**
 * Ceiling on everything this module puts in one prompt, across all folders. The
 * whole point of `--setting-sources ''` in the Claude driver is that nothing gets to
 * silently add tens of thousands of tokens to every turn; re-adding memory by hand
 * without a ceiling would walk straight back into that. The memory folder plus the vault measure
 * ~80k characters, so this leaves room to grow and still refuses a runaway.
 */
export const MAX_PROJECT_MEMORY_CHARS = 150_000

export interface ProjectMemorySource {
  path: string
  content: string
}

export interface ProjectMemoryBundle {
  text: string
  /** Only complete files that were actually included in the prompt. */
  sources: ProjectMemorySource[]
}

/** Said in place of the files that did not fit, so truncation is never silent. */
const truncationNote = (dropped: readonly string[]): string =>
  `[Manor] ${dropped.length} more imported ${dropped.length === 1 ? 'file was' : 'files were'} left out here because the folder instructions passed ${MAX_PROJECT_MEMORY_CHARS} characters: ${dropped.join(', ')}. Read them directly if a question turns on them.`

/**
 * The `@path` imports on one line of a memory file.
 *
 * `@` only opens an import at the start of a line or after whitespace, which is what
 * keeps `name@example.com` and a mid-word `@` out. Anything that survives is
 * still only inlined if it resolves to a real file, so a persona mention like
 * `@Sage` in prose falls through harmlessly.
 */
const IMPORT_PATTERN = /(?:^|\s)@([^\s`]+)/g

/** Trailing punctuation that belongs to the sentence, not to the filename. */
const trimTrailingPunctuation = (target: string): string => target.replace(/[.,;:)\]]+$/, '')

const resolveImport = (fromFile: string, target: string): string => {
  if (target === '~' || target.startsWith('~/')) return path.join(homedir(), target.slice(1))
  if (path.isAbsolute(target)) return target
  return path.resolve(path.dirname(fromFile), target)
}

/**
 * What counts as "already carried". The real path when it resolves, the given path
 * when it does not, so a missing file still dedups against itself.
 */
const resolveIdentity = async (filePath: string): Promise<string> => {
  try {
    return await realpath(filePath)
  } catch {
    return filePath
  }
}

const readIfFile = async (filePath: string): Promise<string | undefined> => {
  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) return undefined
    return await readFile(filePath, 'utf8')
  } catch {
    // Missing, unreadable, or not a file at all. A memory file is a convenience, and
    // a folder without one is the normal case, so nothing here is worth failing a
    // turn over.
    return undefined
  }
}

/**
 * Every `@import` target in a memory file, in the order they appear.
 *
 * Fenced code blocks are skipped: `rules.md` and friends quote command lines and
 * config, and an example that happens to contain `@something` is documentation, not
 * an instruction to load a file.
 */
export function importTargets(content: string): string[] {
  const targets: string[] = []
  let inFence = false
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const match of line.matchAll(IMPORT_PATTERN)) {
      const target = trimTrailingPunctuation(match[1] ?? '')
      if (target.length > 0) targets.push(target)
    }
  }
  return targets
}

/**
 * One folder's memory file plus everything it imports, depth first, each entry kept
 * whole with the absolute path it came from.
 *
 * Depth first rather than breadth first so an import chain reads in the order the
 * author laid it out. `seen` spans the whole call, so a file imported by two parents
 * is carried once and a cycle terminates.
 */
async function collect(
  filePath: string,
  seen: Set<string>,
  depth: number,
): Promise<{ path: string; content: string }[]> {
  if (depth > MAX_IMPORT_DEPTH) return []
  // Identity is the resolved path, not the path we arrived by. `~/.claude/rules/`
  // is symlinks into the memory folder, so in a memory-folder chat the same file is reachable under
  // two names; comparing strings would carry `rules.md` twice and burn the budget
  // proving it.
  const identity = await resolveIdentity(filePath)
  if (seen.has(identity)) return []
  seen.add(identity)
  const content = await readIfFile(filePath)
  if (content === undefined || content.trim().length === 0) return []
  const collected = [{ path: filePath, content: content.trim() }]
  for (const target of importTargets(content)) {
    collected.push(...(await collect(resolveImport(filePath, target), seen, depth + 1)))
  }
  return collected
}

/**
 * One folder's memory file plus its imports, taking the first name in
 * `MEMORY_FILENAMES` that yields anything. A file that exists but is empty counts as
 * nothing, so a stub `CLAUDE.md` does not shadow a real `AGENTS.md` next to it.
 */
async function collectFolder(
  dir: string,
  seen: Set<string>,
): Promise<{ path: string; content: string }[]> {
  for (const filename of MEMORY_FILENAMES) {
    const files = await collect(path.join(dir, filename), seen, 0)
    if (files.length > 0) return files
  }
  return []
}

/**
 * The machine-wide layer: `<globalRoot>/CLAUDE.md` with its imports, then every `.md`
 * under `<globalRoot>/rules/`, which the CLI loads wholesale rather than by import.
 *
 * Read in sorted order so two turns with the same files produce the same prompt, and
 * through the same `seen` set as the folder layer so nothing is carried twice.
 */
async function collectGlobal(
  globalRoot: string,
  seen: Set<string>,
): Promise<{ path: string; content: string }[]> {
  const files = await collectFolder(globalRoot, seen)
  const rulesDir = path.join(globalRoot, GLOBAL_RULES_DIRNAME)
  let ruleNames: string[]
  try {
    ruleNames = (await readdir(rulesDir)).filter((name) => name.endsWith('.md')).sort()
  } catch {
    // No rules directory is the ordinary case on a machine that never made one.
    return files
  }
  for (const name of ruleNames) {
    files.push(...(await collect(path.join(rulesDir, name), seen, 0)))
  }
  return files
}

/**
 * The standing-instructions block for a turn: the linked folders' memory files, then
 * the machine-wide `~/.claude` layer that holds in every session whatever the project
 * is. `''` when neither has anything.
 *
 * This exists because the Claude driver runs with `--setting-sources ''` (see
 * `buildArgs`), which switches off the CLI's own memory loading along with the
 * ambient MCP and hook config it is actually there to keep out. Reading the files
 * here gets the instructions back without getting any of that back. What is consulted
 * stays a closed list: the folders the project linked, and markdown under the global
 * root. Never `settings.json`, `mcp.json`, hooks, plugins, or anything else in
 * `~/.claude` that the flag exists to block.
 *
 * `@` imports are resolved here too, because the CLI's importer is off with the rest
 * of it and the memory folder's `CLAUDE.md` is mostly an import list.
 *
 * Read fresh every turn, not cached: these files are edited by the same personas
 * that read them, and a stale rule is worse than the few milliseconds.
 */
export async function composeProjectMemoryBundle(
  repoPaths: readonly string[],
  options: { globalRoot?: string | null } = {},
): Promise<ProjectMemoryBundle> {
  const globalRoot = options.globalRoot === undefined ? defaultGlobalRoot() : options.globalRoot
  const seen = new Set<string>()

  // Folder layer first, so the project's own instructions lead and the global layer
  // shrinks to whatever the project did not already pull in. In a memory-folder chat that
  // collapses the global set to almost nothing, because the memory folder's `CLAUDE.md` carries
  // a superset of it.
  const folderFiles: { path: string; content: string }[] = []
  for (const repoPath of repoPaths) {
    folderFiles.push(...(await collectFolder(repoPath, seen)))
  }
  const globalCollected = globalRoot === null ? [] : await collectGlobal(globalRoot, seen)
  // Global tool recipes and capture routing are reference material. Explicit project
  // imports remain intact, including when a project deliberately imports these files.
  const referenceNames = new Set(['tools.md', 'map.md'])
  const references = globalCollected.filter((file) => referenceNames.has(path.basename(file.path)))
  const globalFiles = globalCollected.filter((file) => !referenceNames.has(path.basename(file.path)))
  const referenceBlock = references.length === 0 ? '' : [
    '[Manor] Global reference files, read on demand:',
    ...references.map((file) => `- ${file.path}: ${path.basename(file.path) === 'tools.md'
      ? 'Read before using an integration for its route and traps; this file does not grant connections.'
      : 'Read when locating project knowledge, personal context or choosing where to save information.'}`),
  ].join('\n')

  const sections: { heading: string; files: { path: string; content: string }[] }[] = [
    { heading: PROJECT_MEMORY_HEADING, files: folderFiles },
    { heading: GLOBAL_MEMORY_HEADING, files: globalFiles },
  ].filter((section) => section.files.length > 0)
  if (sections.length === 0) return { text: referenceBlock, sources: [] }

  const blocks: string[] = []
  const dropped: string[] = []
  const sources: ProjectMemorySource[] = []
  let budget = MAX_PROJECT_MEMORY_CHARS
  for (const section of sections) {
    const kept: string[] = []
    for (const file of section.files) {
      // Whole files only. Half a rules file reads like a complete one and is the more
      // dangerous of the two failures, so an entry either fits or is named as missing.
      if (file.content.length > budget) {
        dropped.push(file.path)
        continue
      }
      budget -= file.content.length
      kept.push(`${memoryFileHeading(file.path)}\n${file.content}`)
      sources.push(file)
    }
    if (kept.length > 0) blocks.push(section.heading, ...kept)
  }
  if (referenceBlock.length > 0) blocks.push(referenceBlock)
  if (blocks.length === 0) return { text: '', sources: [] }
  if (dropped.length > 0) blocks.push(truncationNote(dropped))
  return { text: blocks.join('\n\n'), sources }
}

/** Backwards-compatible text-only view for callers that do not need provenance. */
export async function composeProjectMemory(
  repoPaths: readonly string[],
  options: { globalRoot?: string | null } = {},
): Promise<string> {
  return (await composeProjectMemoryBundle(repoPaths, options)).text
}
