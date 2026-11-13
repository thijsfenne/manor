import { readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

/** Roughly 6k tokens, while remaining deterministic and tokenizer-independent. */
export const MAX_STRUCTURED_MEMORY_CHARS = 24_000

export const STRUCTURED_MEMORY_HEADING =
  '[Manor] Memory routing indexes. Use their filenames and descriptions to decide which memory files to read for this turn. An index points to memory; it is not evidence for the answer by itself.'

export interface StructuredMemorySource {
  path: string
  kind: 'index' | 'file'
  /** Exactly the part that reached the prompt; a project index may be truncated. */
  content: string
}

export interface StructuredMemoryBundle {
  /** The routing indexes. Changes only when an index file does, so it rides in the prompt. */
  text: string
  /**
   * Files retrieved for the current question, with their own heading. Absent when none
   * were. Re-selected every turn, so it travels as a message block, not in the prompt.
   */
  retrieved?: string
  sources: StructuredMemorySource[]
}

/** Project names are the stable human key Manor has; the memory folder uses the same kebab-case folders. */
export const structuredProjectSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const readIndex = async (filePath: string): Promise<string | undefined> => {
  try {
    const content = await readFile(filePath, 'utf8')
    return content.trim().length === 0 ? undefined : content
  } catch {
    // A missing checkout or index means there is no routing help on this host; it
    // must never stop the answer itself.
    return undefined
  }
}

const fileBlock = (filePath: string, content: string): string => `--- ${filePath} ---\n${content}`

const truncatedBlock = (filePath: string, content: string, available: number): {
  text: string
  included: string
} | undefined => {
  const heading = `--- ${filePath} ---\n`
  const note = `\n\n[Manor] index truncated, read the file: ${filePath}`
  const contentBudget = available - heading.length - note.length
  if (contentBudget < 0) return undefined
  const raw = content.slice(0, contentBudget)
  const lastCompleteLine = raw.lastIndexOf('\n')
  const included = lastCompleteLine > 0 ? raw.slice(0, lastCompleteLine) : raw
  return { text: `${heading}${included}${note}`, included }
}

const minimumTruncatedBlockLength = (filePath: string): number =>
  truncatedBlock(filePath, '', Number.MAX_SAFE_INTEGER)?.text.length ?? 0

const STOPWORDS = new Set('about after also been before could from have into just more only should some than that their them then there these they this those want what when where which will with would your deze door een geen heeft hier hoe iets mijn moet naar niet onze over voor waar welke wordt zijn'.split(' '))
const terms = (text: string): Set<string> => new Set(
  (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((term) => !STOPWORDS.has(term)),
)
export const RETRIEVED_HEADING = '[Manor] Memory files retrieved for this conversation. They are evidence and may be cited; the memory routing indexes remain routing.'
type Candidate = { filePath: string; content: string; kind: StructuredMemorySource['kind'] }

/** Optional rankers score existing index rows; file scope and budgets stay here. */
export type MemoryRowRanker = (request: string, rows: readonly string[], projectName: string, currentQuestion?: string) => Promise<readonly number[]>

export interface StructuredMemoryOptions {
  personalMemory?: boolean
  scope?: 'project' | 'knowledge'
  /** Registered project names, used only for literal mentions in the current question. */
  projectNames?: readonly string[]
  currentQuestion?: string
  /** Files that reach the turn whole elsewhere (a project thread's own two) and are never retrieved. */
  excludePaths?: readonly string[]
}

const indexLink = (row: string) => row.match(/^\s*-\s+\[[^\]]+\]\(([^)]+\.md)\)/)?.[1]
const archived = (filePath: string) => filePath.split(path.sep).some((part) =>
  part === 'archived.md' || part.startsWith('_') || part.startsWith('.'))

async function indexPaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const paths: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (archived(entry.name)) continue
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await indexPaths(filePath))
    else if (entry.isFile() && entry.name === 'MEMORY.md') paths.push(filePath)
  }
  return paths
}

const literalMention = (question: string, name: string): boolean => {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}_])(?:${escape(name)}|${escape(structuredProjectSlug(name))})(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(question)
}

/** Scope is settled before descriptions reach a ranker, including on fallback. */
async function retrieveFiles(indexes: Candidate[], routing: Candidate[], request: string, question: string, projectName: string, reservedChars: number, ranker?: MemoryRowRanker, excludePaths: readonly string[] = []): Promise<Candidate[]> {
  const excluded = new Set((await Promise.all(excludePaths.map((file) => realpath(file).catch(() => undefined))))
    .filter((file): file is string => file !== undefined))
  const wanted = terms(request)
  for (const term of terms(projectName)) wanted.delete(term)
  const links = indexes.flatMap((source) => source.content.split('\n').flatMap((row) => {
    const link = indexLink(row)
    const score = [...terms(row)].filter((term) => wanted.has(term)).length
    return link === undefined ? [] : [{ source, link, score, text: row }]
  }))
  const valid: ((typeof links)[number] & { filePath: string })[] = []
  const seen = new Set<string>()
  for (const row of links) {
    // Containment is checked on resolved paths; the prompt and the trace keep the
    // caller's path, so a `/var` root does not surface as `/private/var`.
    const directory = path.dirname(row.source.filePath)
    const realDirectory = await realpath(directory).catch(() => undefined)
    const real = await realpath(path.resolve(directory, row.link)).catch(() => undefined)
    if (realDirectory === undefined || real === undefined || !real.startsWith(`${realDirectory}${path.sep}`)
      || path.basename(real) === 'MEMORY.md' || archived(path.relative(realDirectory, real))
      || seen.has(real) || excluded.has(real)) continue
    // A filtered root row must not use a symlink to reach a different category.
    if (path.basename(row.link).startsWith('feedback_')
      && (path.dirname(real) !== realDirectory || !path.basename(real).startsWith('feedback_'))) continue
    seen.add(real)
    valid.push({ ...row, filePath: path.join(directory, path.relative(realDirectory, real)) })
  }
  let scores: readonly number[] | undefined
  if (ranker !== undefined && request.trim().length > 0 && valid.length > 0) {
    // One ranker call per index, concurrently. A single flat call over every index
    // lowered every relevant score below the threshold (0.87 to 0.78 for the same
    // row, measured 2026-09-17), so each pool stays the size of one index.
    const groups = [...new Set(valid.map((row) => row.source))]
    const ranked = await Promise.all(groups.map(async (source) => {
      const rows = valid.filter((row) => row.source === source)
      try {
        const result = Array.from(await ranker(request, rows.map((row) => row.text), projectName, question))
        if (result.length !== rows.length || result.some((score) => !Number.isFinite(score))) throw new Error('Invalid ranking')
        return new Map(rows.map((row, index) => [row, result[index]!]))
      } catch (error) {
        // A failed index selects nothing rather than falling back to word overlap.
        // The fallback scores the whole request, so after one earlier question about
        // another subject it re-selects that subject: measured 2026-09-17, a single
        // timed-out index among the knowledge-scope thirty dragged four unrelated
        // files into a gift question. Failure is isolated to its own index, and the
        // persona can still open the file itself. The miss is otherwise invisible in
        // the memory trace, so name the index here; never the rows or the request.
        console.warn(`[manor] memory ranking skipped ${source.filePath} (${rows.length} rows): ${error instanceof Error ? error.message : 'unknown error'}`)
        return new Map(rows.map((row) => [row, 0]))
      }
    }))
    scores = valid.map((row) => ranked.find((group) => group.has(row))!.get(row)!)
  }
  const rows = valid.map((row, index) => ({ ...row, index, score: scores?.[index] ?? row.score }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const selected: Candidate[] = []
  let used = RETRIEVED_HEADING.length + reservedChars
    + routing.reduce((sum, index) => sum + 2 + minimumTruncatedBlockLength(index.filePath), 0)
  for (const row of rows) {
    if (selected.length === 4) break
    const { filePath } = row
    const content = await readIndex(filePath)
    if (content === undefined) continue
    const required = 2 + fileBlock(filePath, content).length
    if (used + required > MAX_STRUCTURED_MEMORY_CHARS) continue
    used += required
    selected.push({ filePath, content, kind: 'file' })
  }
  return selected
}

/**
 * Project scope admits its own index, personal feedback and explicitly named projects.
 * Knowledge scope discovers all active indexes only with personal memory enabled.
 * Discovery stays separate from the bounded prompt. Indexes and retrieved files each
 * have their own ceiling (2026-10-12): the indexes compose the same whatever is
 * retrieved, so the prompt that carries them stays byte-stable between turns, and the
 * files keep the budget they had when they shared one ceiling with the indexes.
 */
export async function composeStructuredMemoryBundle(
  structuredRoot: string | undefined,
  projectName?: string,
  request?: string,
  ranker?: MemoryRowRanker,
  options: StructuredMemoryOptions = {},
): Promise<StructuredMemoryBundle> {
  if (structuredRoot === undefined) return { text: '', sources: [] }
  const rootDirectory = await realpath(structuredRoot).catch(() => undefined)
  if (rootDirectory === undefined) return { text: '', sources: [] }
  const slug = projectName === undefined ? '' : structuredProjectSlug(projectName)
  const personalMemory = options.personalMemory ?? true
  const knowledge = options.scope === 'knowledge' && personalMemory
  const scoped = slug.length > 0 && !knowledge
  const rootRoute = scoped && personalMemory
    ? `\n\n[Manor] For cross-project or personal context explicitly needed by this conversation, read ${path.join(structuredRoot, 'MEMORY.md')}; it is not loaded here.`
    : ''
  const projectPath = slug.length === 0 ? undefined : path.join(structuredRoot, slug, 'MEMORY.md')
  const rootPath = path.join(structuredRoot, 'MEMORY.md')
  const question = options.currentQuestion ?? request ?? ''
  const candidatePaths = new Set([
    ...(projectPath === undefined ? [] : [projectPath]),
    ...(knowledge ? await indexPaths(structuredRoot) : [
      ...(personalMemory ? [rootPath] : []),
      ...(slug.length === 0 ? [] : (options.projectNames ?? []).filter((name) => literalMention(question, name))
        .map((name) => path.join(structuredRoot, structuredProjectSlug(name), 'MEMORY.md'))),
    ]),
  ])
  const indexes: Candidate[] = []
  for (const filePath of candidatePaths) {
    // Index symlinks cannot widen an otherwise valid scope; paths stay as the caller
    // spelled them so the prompt and the trace match the configured root.
    if (await realpath(filePath).catch(() => undefined) !== path.join(rootDirectory, path.relative(structuredRoot, filePath))) continue
    let content = await readIndex(filePath)
    if (content === undefined) continue
    if (filePath === rootPath && scoped) {
      content = content.split('\n').filter((row) => /^feedback_[^/\\]+\.md$/.test(indexLink(row) ?? '')).join('\n')
      if (!content) continue
    }
    indexes.push({ filePath, content, kind: 'index' })
  }
  // Wide discovery does not dump every candidate index into the answering prompt.
  const candidates = indexes.filter((index) => index.filePath === projectPath || index.filePath === rootPath)
  const files = request === undefined || (slug.length === 0 && !knowledge) ? []
    : await retrieveFiles(indexes, candidates, request, question, projectName ?? '', rootRoute.length, ranker, options.excludePaths)
  const blocks = [STRUCTURED_MEMORY_HEADING]
  const sources: StructuredMemorySource[] = []
  let used = STRUCTURED_MEMORY_HEADING.length + rootRoute.length

  for (const [index, { filePath, content, kind }] of candidates.entries()) {
    const separator = '\n\n'
    const reserved = candidates.slice(index + 1).reduce((sum, next) => sum + separator.length + minimumTruncatedBlockLength(next.filePath), 0)
    const available = MAX_STRUCTURED_MEMORY_CHARS - used - separator.length - reserved
    const whole = fileBlock(filePath, content)
    if (whole.length <= available) {
      blocks.push(whole)
      sources.push({ path: filePath, content, kind })
      used += separator.length + whole.length
      continue
    }
    const truncated = truncatedBlock(filePath, content, available)
    if (truncated !== undefined) {
      blocks.push(truncated.text)
      sources.push({ path: filePath, content: truncated.included, kind })
      used += separator.length + truncated.text.length
    }
  }
  // Selected to fit their budget in `retrieveFiles`, so each arrives whole.
  for (const { filePath, content, kind } of files) sources.push({ path: filePath, content, kind })
  const retrieved = files.length === 0
    ? undefined
    : [RETRIEVED_HEADING, ...files.map(({ filePath, content }) => fileBlock(filePath, content))].join('\n\n')

  const text = blocks.length === 1 ? rootRoute.trim() : blocks.join('\n\n') + rootRoute
  return { text, ...(retrieved === undefined ? {} : { retrieved }), sources }
}
