import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { projectFileWriteDetail, projectFileWriteLabel, type AgentConfig, type NotesUpdate, type ProjectFileWrite, type ServerMessage } from '@manor/contracts'
import type { UserInputContext } from './interactionCapability.js'
import { agentNotesPath, type MemoryTarget } from './memoryTarget.js'
import { applyThreadLineOp, datedPreference, inverseWrite, isPinned, readThreadFile, withThreadFileLock, writeThreadFile, type ThreadLineOp } from './projectFiles.js'
import type { Store } from './store.js'

export const AGENT_NOTES_HEADING = '[Manor] Standing notes for you:'

export interface AgentNotesSource {
  path: string
  content: string
}

export interface AgentNotesBundle {
  text: string
  sources: AgentNotesSource[]
}

/**
 * The persona's own standing notes, when the file exists, always whole: a cut note is a
 * missed one. Callers with memory off must not call this. A missing or empty file is
 * the way off, nothing else to unwire.
 */
export async function composeAgentNotesBundle(
  target: MemoryTarget | undefined,
  agentId: string,
): Promise<AgentNotesBundle> {
  const filePath = agentNotesPath(target, agentId)
  if (filePath === undefined) return { text: '', sources: [] }
  let content: string
  try {
    content = (await readFile(filePath, 'utf8')).trim()
  } catch {
    return { text: '', sources: [] }
  }
  if (content.length === 0) return { text: '', sources: [] }
  return {
    text: `${AGENT_NOTES_HEADING}\n--- ${filePath} ---\n${content}`,
    sources: [{ path: filePath, content }],
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

/** The lines a reader counts as notes, without their bullet: not blank, not a heading, not the capacity line. */
const noteLines = (text: string | null): string[] => (text ?? '').split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#') && !/^>\s*capacity:/i.test(line))
  .map((line) => line.replace(/^[-*+]\s+/, ''))

/** Lines in `side` beyond the ones `other` holds, counting duplicates. */
function surplus(side: readonly string[], other: readonly string[]): string[] {
  const left = new Map<string, number>()
  for (const line of other) left.set(line, (left.get(line) ?? 0) + 1)
  return side.filter((line) => {
    const held = left.get(line) ?? 0
    if (held > 0) left.set(line, held - 1)
    return held === 0
  })
}

/**
 * What a turn did to the persona's notes with a file tool, for the chat line with View.
 * `viaTool` is what `update_notes` added and removed in the turn; those lines carry their
 * own Undo and are left out. Undefined when no other note line changed.
 */
export function notesUpdateOf(
  before: string | null,
  after: string | null,
  viaTool: { added: readonly string[]; removed: readonly string[] } = { added: [], removed: [] },
): NotesUpdate | undefined {
  if (before === after) return undefined
  const added = surplus(surplus(noteLines(after), noteLines(before)), viaTool.added).length
  const removed = surplus(surplus(noteLines(before), noteLines(after)), viaTool.removed).length
  return added + removed === 0 ? undefined : { added, removed }
}

/** An agent's notes line holds at most this, the date Manor appends included. */
export const AGENT_NOTE_LINE_MAX = 160
/** Past this many lines the tool result asks to merge; the write still lands. */
const AGENT_NOTES_SOFT_LINES = 20

export interface AgentNotesInput {
  action: ThreadLineOp['action']
  line?: string
  old?: string
}

export interface AgentNotesWriterOptions {
  store: Pick<Store, 'appendEvent' | 'getChat'>
  memoryTarget: MemoryTarget | undefined
  agents: () => readonly AgentConfig[]
  emit: (message: ServerMessage) => void
  isActiveTurn: (chatId: string, agentId: string, turnId: string) => boolean
}

/**
 * `update_notes`: one line in the calling agent's own `memory/agents/<id>.md`, only with
 * memory on. Each write shows in the chat with Undo, like a project thread's.
 */
export class AgentNotesWriter {
  /** Lines each running turn wrote through the tool, so the turn-end check counts only what went past it. */
  private readonly written = new Map<string, { added: string[]; removed: string[] }>()

  constructor(private readonly options: AgentNotesWriterOptions) {}

  async write(context: UserInputContext, input: AgentNotesInput): Promise<string> {
    if (!this.options.isActiveTurn(context.chatId, context.agentId, context.turnId)) {
      throw new Error('Only a running turn can write its notes.')
    }
    const agent = this.options.agents().find((candidate) => candidate.id === context.agentId)
    if (agent === undefined) throw new Error('Only an agent of this workspace keeps notes.')
    if (!agent.memoryScope) throw new Error('Memory is off for you, so you keep nothing. Say so in one short sentence.')
    const chat = await this.options.store.getChat(context.chatId)
    if ((chat?.kind !== 'dm' && chat?.kind !== 'group') || chat.mode === 'single') {
      throw new Error('You keep notes only from a DM or a group chat with the user.')
    }
    const target = agentNotesPath(this.options.memoryTarget, agent.id)
    if (target === undefined) throw new Error('This workspace has no memory folder, so nothing is kept.')
    const written = input.line === undefined ? undefined : datedPreference(input.line.trim().replace(/^[-*+]\s+/, ''), new Date())
    if (written !== undefined && /[\r\n]/.test(written)) throw new Error('A note is one line. Write one agreement per call.')
    if (written !== undefined && written.length > AGENT_NOTE_LINE_MAX) {
      throw new Error(`A note holds at most ${AGENT_NOTE_LINE_MAX} characters, its date included; this one has ${written.length}. Keep the agreement itself short.`)
    }
    const op: ThreadLineOp | undefined =
      input.action === 'add' && written !== undefined ? { action: 'add', line: written }
        : input.action === 'replace' && written !== undefined && input.old !== undefined ? { action: 'replace', old: input.old, line: written }
          : input.action === 'remove' && input.old !== undefined ? { action: 'remove', old: input.old }
            : undefined
    if (op === undefined) throw new Error('add needs `line`, replace needs `old` and `line`, remove needs `old`.')
    const { content, landed } = await applyNotesLine(target, op, `# ${agent.name}\n\n`)
    const shown = (text: string) => text.replace(/^\s*-\s+/, '').trim()
    const write: ProjectFileWrite = {
      file: path.basename(target),
      action: landed.action,
      ...('line' in landed ? { line: shown(landed.line) } : {}),
      ...('old' in landed ? { old: shown(landed.old) } : {}),
      by: agent.name.slice(0, 200),
      turnId: context.turnId,
      agentId: agent.id,
      writeId: randomUUID(),
    }
    const turn = this.written.get(context.turnId) ?? { added: [], removed: [] }
    if (write.line !== undefined) turn.added.push(write.line)
    if (write.old !== undefined) turn.removed.push(write.old)
    this.written.set(context.turnId, turn)
    const event = await this.options.store.appendEvent(context.chatId, {
      type: 'system_note',
      kind: 'info',
      agentId: agent.id,
      text: `${projectFileWriteLabel(write)}: ${projectFileWriteDetail(write) ?? ''}`,
      projectFileWrite: write,
    })
    this.options.emit({ type: 'event', chatId: context.chatId, event })
    const lines = noteLines(content).length
    return lines > AGENT_NOTES_SOFT_LINES
      ? `Saved in your notes. They now hold ${lines} lines: merge lines that overlap and drop what no longer holds before you add another.`
      : 'Saved in your notes.'
  }

  /** What this turn's tool writes added and removed. Read once, at the turn's end. */
  takeTurnWrites(turnId: string): { added: readonly string[]; removed: readonly string[] } {
    const turn = this.written.get(turnId) ?? { added: [], removed: [] }
    this.written.delete(turnId)
    return turn
  }

  /** Undo on one `update_notes` write: the reverse line change, only while its line still reads exactly that way. */
  async undoWrite(write: ProjectFileWrite): Promise<string | undefined> {
    const reverse = inverseWrite(write)
    const target = write.agentId === undefined ? undefined : agentNotesPath(this.options.memoryTarget, write.agentId)
    if (reverse === undefined || target === undefined) return 'There is no memory write to undo here.'
    try {
      await applyNotesLine(target, reverse, undefined, true)
    } catch (error) {
      return `Nothing was undone: ${error instanceof Error ? error.message : 'the file could not be written.'}`
    }
    return undefined
  }
}

/**
 * One line change to an agent's notes file. The file is read again just before the
 * rename and the change redone on what it then reads, because the user and the memory
 * routine write it too. `seed` starts a file that does not exist yet. A quoted line may
 * lack the date Manor appended, except for Undo (`exact`). `landed` is the change as the
 * file took it.
 */
async function applyNotesLine(target: string, op: ThreadLineOp, seed?: string, exact = false): Promise<{ content: string; landed: ThreadLineOp }> {
  if (seed !== undefined) await mkdir(path.dirname(target), { recursive: true })
  return withThreadFileLock(target, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await readThreadFile(target)
      if (isPinned(current)) throw new Error('This file is pinned.')
      let landed = op
      if (op.action !== 'add' && !exact) {
        const undated = (text: string) => text.replace(/^\s*-\s+/, '').trim().replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '')
        const matches = current.split('\n').filter((line) => /^\s*-\s+/.test(line) && undated(line) === undated(op.old))
        if (matches.length === 1) landed = { ...op, old: matches[0]! }
      }
      const applied = applyThreadLineOp(current === '' && seed !== undefined ? seed : current, landed)
      if ('error' in applied) throw new Error(applied.error)
      if (await writeThreadFile(target, applied.content, current)) return { content: applied.content, landed }
    }
    throw new Error(`${path.basename(target)} kept changing while Manor wrote to it. Read it again and retry.`)
  })
}
