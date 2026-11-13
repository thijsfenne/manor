import { readFile } from 'node:fs/promises'
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
