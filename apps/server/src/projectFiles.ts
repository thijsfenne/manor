import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectThreadFile } from '@manor/contracts'
import { localDate } from './memoryWriter.js'
import { structuredProjectSlug } from './structuredMemory.js'

/**
 * The two files a project thread owns (decided 2026-10-10): `preferences.md` and
 * `notes.md` in the project's structured memory folder, the folder retrieval and the
 * Project memory panel already read. The frontmatter marker tells the dream routine to
 * leave them alone; hiding the project keeps the marker and the files as they are.
 */
export const PROJECT_THREAD_OWNER_LINE = 'owner: project-thread'

/**
 * One screen of `preferences.md`. The file always loads whole; past this the thread is
 * told to consolidate, so it shrinks before it costs context, and nothing is cut.
 */
export const PREFERENCES_BUDGET = 3_000

/** How a project thread signs its own writes and handoffs. Display only, nothing matches on it. */
export const PROJECT_THREAD_WRITER = 'Project thread'

export interface ProjectThreadPaths {
  folder: string
  index: string
  preferences: string
  notes: string
}

export const projectThreadPaths = (structuredRoot: string, projectName: string): ProjectThreadPaths => {
  const folder = path.join(structuredRoot, structuredProjectSlug(projectName))
  return {
    folder,
    index: path.join(folder, 'MEMORY.md'),
    preferences: path.join(folder, 'preferences.md'),
    notes: path.join(folder, 'notes.md'),
  }
}

export const threadFilePath = (paths: ProjectThreadPaths, file: ProjectThreadFile): string =>
  file === 'preferences.md' ? paths.preferences : paths.notes

const readOrEmpty = (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '')

export const readThreadFile = readOrEmpty

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** The file without its frontmatter: what a turn reads and what the rule applies to. */
export function threadFileBody(content: string): string {
  return content.replace(FRONTMATTER, '').trim()
}

/** The bullet lines of a thread file, without their `- ` marker. */
export function threadFileLines(content: string): string[] {
  return threadFileBody(content).split('\n')
    .map((line) => /^\s*-\s+(.*\S)\s*$/.exec(line)?.[1])
    .filter((line): line is string => line !== undefined)
}

function withOwner(content: string): string {
  const match = FRONTMATTER.exec(content)
  if (match === null) return `---\n${PROJECT_THREAD_OWNER_LINE}\n---\n${content}`
  if (match[1]!.split('\n').some((line) => line.trim() === PROJECT_THREAD_OWNER_LINE)) return content
  return `---\n${match[1]}\n${PROJECT_THREAD_OWNER_LINE}\n---\n${content.slice(match[0].length)}`
}

const SKELETON: Record<ProjectThreadFile, (project: string) => string> = {
  'preferences.md': (project) => `# Preferences for ${project}\n\n`,
  'notes.md': (project) => `# Notes for ${project}\n\n`,
}

const INDEX_ROWS: Record<ProjectThreadFile, string> = {
  'preferences.md': '- [Preferences](preferences.md): Standing preferences, curated by the project thread and loaded in full on every turn of this project.',
  'notes.md': '- [Notes](notes.md): Current status per item, curated by the project thread.',
}

/** Each step remains idempotent so startup also repairs missing setup files. */
const PROJECT_SETUP_UPGRADES = [
  { version: 1, index: (content: string) => content.replace(
    /^(\s*- \[[^\]\n]+\]\([^\n)]+\)) *(?:,|—) *(.*)$/gm,
    '$1: $2',
  ) },
] as const
export const PROJECT_SETUP_VERSION = PROJECT_SETUP_UPGRADES.at(-1)!.version

export const isPinned = (content: string): boolean =>
  FRONTMATTER.exec(content)?.[1]?.split('\n').some((line) => /^pinned:\s*true\s*$/.test(line.trim())) ?? false

export interface ProjectFileChange {
  path: string
  kinds: ('added-file' | 'owner-marker' | 'index-row' | 'index-row-added' | 'heading')[]
}

async function readSetupFile(file: string): Promise<string | undefined> {
  return readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}

/** Plans and applies the same additive setup; pinned files are never written. */
export async function ensureProjectThreadFiles(
  paths: ProjectThreadPaths,
  projectName: string,
  { files = ['preferences.md', 'notes.md'], dryRun = false }: {
    files?: readonly ProjectThreadFile[]
    dryRun?: boolean
  } = {},
): Promise<ProjectFileChange[]> {
  const changes: ProjectFileChange[] = []
  const save = async (target: string, current: string | undefined, next: string, kinds: ProjectFileChange['kinds']) => {
    if (next === current) return
    changes.push({ path: target, kinds: current === undefined ? ['added-file'] : kinds })
    if (!dryRun) {
      await mkdir(paths.folder, { recursive: true })
      await writeThreadFile(target, next)
    }
  }
  for (const file of files) {
    const target = threadFilePath(paths, file)
    await withThreadFileLock(target, async () => {
      const current = await readSetupFile(target)
      if (isPinned(current ?? '')) return
      let next = current ?? SKELETON[file](projectName)
      const kinds: ProjectFileChange['kinds'] = []
      if (!/^# /m.test(threadFileBody(next))) {
        const head = FRONTMATTER.exec(next)?.[0] ?? ''
        next = head + SKELETON[file](projectName) + next.slice(head.length)
        kinds.push('heading')
      }
      const marked = withOwner(next)
      if (marked !== next) kinds.push('owner-marker')
      next = marked
      await save(target, current, next, kinds)
    })
  }
  await withThreadFileLock(paths.index, async () => {
    const current = await readSetupFile(paths.index)
    if (isPinned(current ?? '')) return
    let next = current ?? `# ${projectName} memory index\n\n`
    const kinds: ProjectFileChange['kinds'] = []
    for (const step of PROJECT_SETUP_UPGRADES) next = step.index(next)
    if (next !== current) kinds.push('index-row')
    const missing = files.filter((file) => !next.includes(`](${file})`))
    if (missing.length > 0) {
      kinds.push('index-row-added')
      if (!next.endsWith('\n')) next += '\n'
      next += missing.map((file) => INDEX_ROWS[file]).join('\n') + '\n'
    }
    await save(paths.index, current, next, kinds)
  })
  return changes
}

export type ThreadLineOp =
  | { action: 'add'; line: string }
  | { action: 'replace'; old: string; line: string }
  | { action: 'remove'; old: string }

const bare = (line: string): string => line.replace(/^\s*-\s+/, '').trim()

/**
 * One line change to a thread file. Replacing and removing match an existing bullet by
 * its exact text, so a stale view of the file fails instead of editing the wrong line.
 */
export function applyThreadLineOp(content: string, op: ThreadLineOp): { content: string } | { error: string } {
  const lines = content.split('\n')
  const find = (old: string) => lines.findIndex((line) => /^\s*-\s+/.test(line) && bare(line) === bare(old))
  if (op.action === 'add') {
    const line = bare(op.line)
    if (line.length === 0 || line.includes('\n')) return { error: 'A line must be one non-empty line.' }
    if (find(line) >= 0) return { error: 'That line is already in the file.' }
    const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`
    return { content: `${body}- ${line}\n` }
  }
  const at = find(op.old)
  if (at < 0) return { error: `No line reads ${JSON.stringify(bare(op.old))}. Read the file again and quote the line exactly.` }
  if (op.action === 'remove') {
    lines.splice(at, 1)
    return { content: lines.join('\n') }
  }
  const line = bare(op.line)
  if (line.length === 0 || line.includes('\n')) return { error: 'A line must be one non-empty line.' }
  lines[at] = `- ${line}`
  return { content: lines.join('\n') }
}

/**
 * A preference the thread writes ends in the day it was written, so a reader can tell
 * an old preference from a new one. A line that already ends in a date keeps it.
 */
export function datedPreference(line: string, now: Date): string {
  const text = bare(line)
  return /\(\d{4}-\d{2}-\d{2}\)$/.test(text) ? text : `${text} (${localDate(now)})`
}

const CHECKED_ROW = /^[-*+]\s+\[[xX]\](\s|$)/

/**
 * A failed write leaves the previous file intact. With `expected`, the file is read again
 * just before the rename and left alone when it no longer reads that way, because a
 * writer outside this process (the memory folder's own maintenance routine) may have changed it meanwhile.
 */
export async function writeThreadFile(file: string, content: string, expected?: string): Promise<boolean> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content)
    if (expected !== undefined && await readOrEmpty(file) !== expected) return false
    await rename(temporary, file)
    return true
  } finally {
    await rm(temporary, { force: true })
  }
}

/** One thread write to a preferences line holds at most this, its date included. */
export const PREFERENCE_LINE_MAX = 160

/** The cap every memory card keeps, metadata included (`project_manor_decision_cards`). */
export const CARD_WORD_CAP = 600

const cardWords = (content: string): number => content.split(/\s+/).filter(Boolean).length

/** The cards a project's `MEMORY.md` lists in its own folder, by filename. */
export function indexedCards(index: string): Set<string> {
  return new Set(index.split('\n').flatMap((row) => {
    const link = /^\s*-\s+\[[^\]]+\]\(([^)\s]+)\)/.exec(row)?.[1]
    return link === undefined || link.includes('/') ? [] : [link]
  }))
}

/**
 * Appends one bullet at the end of the card's Decision section, before the next bold
 * heading, or at the end of a card without one.
 */
export function appendCardDecision(content: string, line: string): { content: string } | { error: string } {
  const bullet = bare(line)
  if (bullet.length === 0 || bullet.includes('\n')) return { error: 'A line must be one non-empty line.' }
  if (content.split('\n').some((existing) => bare(existing) === bullet)) return { error: 'That line is already on the card.' }
  const lines = content.replace(/\n+$/, '').split('\n')
  const decision = lines.findIndex((existing) => /^\*\*Decision:\*\*/.test(existing))
  let at = lines.length
  if (decision >= 0) {
    const next = lines.findIndex((existing, index) => index > decision && /^\*\*[^*\n]+:\*\*/.test(existing))
    at = next < 0 ? lines.length : next
    while (at > decision + 1 && lines[at - 1]!.trim() === '') at -= 1
  }
  lines.splice(at, 0, `- ${bullet}`)
  const next = `${lines.join('\n')}\n`
  if (cardWords(next) > CARD_WORD_CAP) {
    return { error: `The card would pass its ${CARD_WORD_CAP}-word cap. Leave it as it is: the user consolidates a full card in a session, or propose a new card.` }
  }
  return { content: next }
}

export interface NewCard {
  file: string
  title: string
  description: string
  when: string
  line: string
}

/** A new card in the When / Decision / Rejected / Stop skeleton, and its catalogue row. */
export function newCard(card: NewCard): { content: string; row: string } | { error: string } {
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
  const content = [
    '---',
    `name: ${card.file.replace(/\.md$/, '')}`,
    `description: ${JSON.stringify(oneLine(card.description))}`,
    'metadata:',
    '  node_type: memory',
    '  type: project',
    '---',
    '',
    `**When:** ${oneLine(card.when)}`,
    '',
    '**Decision:**',
    `- ${bare(card.line)}`,
    '',
    '**Rejected:** None recorded yet.',
    '',
    '**Stop:** Reversing this needs the user.',
    '',
  ].join('\n')
  if (cardWords(content) > CARD_WORD_CAP) return { error: `The card would pass its ${CARD_WORD_CAP}-word cap. Shorten it.` }
  return { content, row: `- [${oneLine(card.title)}](${card.file}): ${oneLine(card.description)}` }
}

/**
 * Writes a file that must not exist yet. The hard link fails when another writer created
 * it meanwhile, so nothing is overwritten.
 */
export async function createThreadFile(file: string, content: string): Promise<boolean> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content)
    await link(temporary, file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * The Decision lines of the listed cards a `preferences.md` line links to, which may cover
 * a Session question the way the preference line itself does. Rejected and Stop text,
 * unlisted files and anything resolving outside the folder never count.
 */
export async function linkedCardLines(paths: ProjectThreadPaths, preferences: string): Promise<{ file: string; line: string }[]> {
  const listed = indexedCards(await readOrEmpty(paths.index))
  const folder = await realpath(paths.folder).catch(() => undefined)
  const files = new Set(threadFileLines(preferences).flatMap((line) => [...line.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((match) => match[1]!)))
  const lines: { file: string; line: string }[] = []
  for (const file of files) {
    if (folder === undefined || !listed.has(file) || file === 'preferences.md' || file === 'notes.md') continue
    const real = await realpath(path.join(paths.folder, file)).catch(() => undefined)
    if (real === undefined || path.dirname(real) !== folder) continue
    lines.push(...cardDecisionLines(await readOrEmpty(real)).map((line) => ({ file, line })))
  }
  return lines
}

/** The text of a card's Decision section, one entry per line, without markers. */
export function cardDecisionLines(content: string): string[] {
  const lines = threadFileBody(content).split('\n')
  const start = lines.findIndex((line) => /^\*\*Decision:\*\*/.test(line))
  if (start < 0) return []
  const end = lines.findIndex((line, index) => index > start && /^\*\*[^*\n]+:\*\*/.test(line))
  return lines.slice(start, end < 0 ? lines.length : end)
    .map((line, index) => (index === 0 ? line.replace(/^\*\*Decision:\*\*/, '') : line).replace(/^\s*-\s+/, '').trim())
    .filter(Boolean)
}

/** Uses the same block boundaries for cleanup and exact archive deduplication. */
function splitCompletedNotes(content: string, allowed?: ReadonlySet<string>): { content: string; blocks: string[] } {
  const head = FRONTMATTER.exec(content)?.[0] ?? ''
  const lines = content.slice(head.length).split('\n')
  const kept: string[] = []
  const blocks: string[] = []
  let fence: string | undefined
  for (let at = 0; at < lines.length; at += 1) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[at]!)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && lines[at]!.trim() === marker) fence = undefined
      kept.push(lines[at]!)
      continue
    }
    if (fence !== undefined) { kept.push(lines[at]!); continue }
    if (!CHECKED_ROW.test(lines[at]!)) { kept.push(lines[at]!); continue }
    let end = at + 1
    for (let next = end; next < lines.length; next += 1) {
      if (/^[ \t]+\S/.test(lines[next]!)) end = next + 1
      else if (lines[next]!.trim() !== '') break
    }
    const block = lines.slice(at, end).join('\n')
    if (allowed === undefined || allowed.has(block)) blocks.push(block)
    else kept.push(...lines.slice(at, end))
    at = end - 1
  }
  return { content: head + kept.join('\n'), blocks }
}

/**
 * Moves checked top-level task rows (with their indented continuation and sub-items) of
 * `notes.md` into `_archive/notes.md` and returns the active content without them. The
 * caller holds the notes lock and writes the result; this never writes the active file.
 * The archive is written first and skips exact blocks it already holds, so a retry after
 * a failed notes write adds nothing twice. Any archive error keeps the source intact.
 */
export async function archiveCompletedNotes(paths: ProjectThreadPaths, content: string): Promise<string> {
  if (isPinned(content)) return content
  const split = splitCompletedNotes(content)
  if (split.blocks.length === 0) return content

  const file = path.join(paths.folder, '_archive', 'notes.md')
  await mkdir(path.dirname(file), { recursive: true })
  const existing = await readSetupFile(file)
  if (isPinned(existing ?? '')) throw new Error('The Notes archive is pinned.')
  let archive = existing ?? `---\n${PROJECT_THREAD_OWNER_LINE}\n---\n# Archived notes\n\n`
  const identity = (block: string) => block.replace(/<!-- manor-note handoff=([^\s]+) updated=\d+ text=[a-f0-9]+ -->/g, '<!-- manor-note handoff=$1 -->')
  const saved = new Set(splitCompletedNotes(archive).blocks.map(identity))
  const fresh = split.blocks.filter((block) => {
    const key = identity(block)
    if (saved.has(key)) return false
    saved.add(key)
    return true
  })
  if (fresh.length > 0) {
    if (!archive.endsWith('\n')) archive += '\n'
    await writeThreadFile(file, `${archive}${fresh.join('\n')}\n`)
  }
  return split.content
}

/** Removes only complete blocks already accepted by the owner guard. */
export const removeTrustedCompletedNotes = (content: string, trusted: string): string =>
  splitCompletedNotes(content, new Set(splitCompletedNotes(trusted).blocks)).content

/** Serialises writes per file, so two writers decide on each other's result. */
const tails = new Map<string, Promise<unknown>>()

export function withThreadFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const ahead = tails.get(file) ?? Promise.resolve()
  const run = ahead.then(task, task)
  const settled = run.then(() => undefined, () => undefined)
  tails.set(file, settled)
  void settled.then(() => { if (tails.get(file) === settled) tails.delete(file) })
  return run
}

/** Past one screen, the thread's cue to shorten lines before it adds more. */
export const overPreferencesBudget = (content: string): boolean => threadFileBody(content).length > PREFERENCES_BUDGET

/** The block every turn of a project with a thread receives, always the whole file. */
export function preferencesBlock(projectName: string, filePath: string, content: string, owner = false): string {
  const body = threadFileBody(content)
  return [
    owner
      ? `[Manor] Current preferences.md for ${projectName}, from ${filePath}. You maintain it with update_project_file.`
      : `[Manor] Project preferences for ${projectName}, from ${filePath}. They apply to every turn in this project and outrank a general default. Each line is the rule itself; a link names the card in the same folder that holds its reason and detail, so read that card when its line applies to your work. Only the project thread and the user write this file; never edit it. A new preference goes to the thread: a session reports it in goal_reached learnings.`,
    body.length === 0 ? '(no preferences yet)' : body,
    ...(owner && body.length > PREFERENCES_BUDGET
      ? [`[Manor] This file is past its one-screen budget of ${PREFERENCES_BUDGET} characters. Shorten its lines and move their detail into the linked cards with update_project_file before you add another.`]
      : []),
  ].join('\n')
}
