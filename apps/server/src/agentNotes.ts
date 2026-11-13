import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { NOTES_UNDO_MAX, type NotesUpdate } from '@manor/contracts'
import { agentNotesPath, type MemoryTarget } from './memoryTarget.js'

/**
 * Emergency brake, not the budget. Personas and dream keep notes under 400 words;
 * at the ~6.3 characters per word measured on the fullest notes that runs to
 * ~2,530 characters, so the cut sits above it and only fires on an overgrown file.
 */
export const MAX_AGENT_NOTES_CHARS = 3_000

export const AGENT_NOTES_HEADING = '[Manor] Standing notes for you:'

export interface AgentNotesSource {
  path: string
  content: string
}

export interface AgentNotesBundle {
  text: string
  sources: AgentNotesSource[]
  truncated: boolean
}

/** Said in place of the tail that did not fit, so truncation is never silent and gets fixed. */
const truncationNote = (filePath: string): string =>
  `[Manor] notes truncated, the rest is in ${filePath}. Consolidate that file to under 400 words.`

/**
 * The persona's own standing notes, when the file exists. Callers with memory
 * off must not call this. A missing or empty file is the way off, nothing else
 * to unwire.
 */
export async function composeAgentNotesBundle(
  target: MemoryTarget | undefined,
  agentId: string,
): Promise<AgentNotesBundle> {
  const filePath = agentNotesPath(target, agentId)
  if (filePath === undefined) return { text: '', sources: [], truncated: false }
  let raw: string
  try {
    raw = (await readFile(filePath, 'utf8')).trim()
  } catch {
    return { text: '', sources: [], truncated: false }
  }
  if (raw.length === 0) return { text: '', sources: [], truncated: false }

  const heading = `--- ${filePath} ---\n`
  const note = `\n\n${truncationNote(filePath)}`
  let content = raw
  if (raw.length > MAX_AGENT_NOTES_CHARS) {
    const budget = MAX_AGENT_NOTES_CHARS
    const cut = raw.slice(0, budget)
    const lastLine = cut.lastIndexOf('\n')
    content = lastLine > 0 ? cut.slice(0, lastLine) : cut
  }
  const truncated = content !== raw
  const body = truncated ? `${heading}${content}${note}` : `${heading}${content}`
  return {
    text: `${AGENT_NOTES_HEADING}\n${body}`,
    sources: [{ path: filePath, content }],
    truncated,
  }
}

/** The notes file as it is on disk: null when there is none, undefined when it cannot be read. */
export async function readNotesFile(filePath: string): Promise<string | null | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
}

const hashOf = (text: string | null): string | null => text === null ? null : createHash('sha256').update(text).digest('hex')

/** The lines a reader counts as notes: not blank, not a heading, not the capacity line. */
const noteLines = (text: string | null): string[] => (text ?? '').split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#') && !/^>\s*capacity:/i.test(line))

/** Lines in `side` beyond the ones `other` holds, counting duplicates. */
function surplus(side: readonly string[], other: readonly string[]): number {
  const left = new Map<string, number>()
  for (const line of other) left.set(line, (left.get(line) ?? 0) + 1)
  let count = 0
  for (const line of side) {
    const held = left.get(line) ?? 0
    if (held === 0) count += 1
    else left.set(line, held - 1)
  }
  return count
}

/**
 * What a turn did to the persona's notes, for the chat line and its Undo. Undefined when
 * no note line changed (a capacity count alone is not news) or the file is too large to
 * keep a copy of.
 */
export function notesUpdateOf(before: string | null, after: string | null): NotesUpdate | undefined {
  if (before === after || (before?.length ?? 0) > NOTES_UNDO_MAX) return undefined
  const added = surplus(noteLines(after), noteLines(before))
  const removed = surplus(noteLines(before), noteLines(after))
  if (added + removed === 0) return undefined
  return { added, removed, before, afterHash: hashOf(after) }
}

/**
 * Undo of one turn's notes change: puts the file back as the turn found it, only while it
 * is still exactly as the turn left it. A later edit by anyone (the agent, the dream, the
 * user) refuses it and changes nothing. A local file edit in the memory folder, like
 * every other memory write.
 */
export async function undoNotesUpdate(filePath: string, update: NotesUpdate): Promise<'undone' | 'changed'> {
  const current = await readNotesFile(filePath)
  if (current === undefined) throw new Error('Could not read the notes file.')
  if (hashOf(current) !== update.afterHash) return 'changed'
  if (update.before === null) await rm(filePath, { force: true })
  else await writeFile(filePath, update.before, 'utf8')
  return 'undone'
}
