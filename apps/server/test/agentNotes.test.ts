import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentConfig, ThreadEvent } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_NOTES_HEADING, AgentNotesWriter, composeAgentNotesBundle, notesUpdateOf } from '../src/agentNotes.js'
import { localDate } from '../src/memoryWriter.js'
import * as projectFiles from '../src/projectFiles.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { sage, seededChat, smith } from './helpers.js'

describe('composeAgentNotesBundle', () => {
  it('returns nothing on the relay branch or when the file is missing', async () => {
    await expect(composeAgentNotesBundle(undefined, 'sage')).resolves.toEqual({ text: '', sources: [] })
    const dailyDir = await mkdtemp(path.join(os.tmpdir(), 'manor-notes-missing-'))
    await expect(composeAgentNotesBundle({ dailyDir }, 'sage')).resolves.toEqual({ text: '', sources: [] })
  })

  it('injects the whole file when it exists, and traces the path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'manor-notes-'))
    const dailyDir = path.join(root, 'memory', 'daily')
    const filePath = path.join(root, 'memory', 'agents', 'sage.md')
    await mkdir(path.dirname(filePath), { recursive: true })
    const long = Array.from({ length: 80 }, (_, index) => `- line ${index} ${'x'.repeat(40)}`).join('\n')
    await writeFile(filePath, `${long}\n`, 'utf8')

    const bundle = await composeAgentNotesBundle({ dailyDir }, 'sage')
    expect(bundle.text).toContain(AGENT_NOTES_HEADING)
    expect(bundle.text).toContain('- line 79')
    expect(bundle.sources).toEqual([{ path: filePath, content: long }])
  })
})

describe('notesUpdateOf', () => {
  it('counts a file-tool edit and leaves out the lines the tool wrote', () => {
    expect(notesUpdateOf('# Sage\n\n- One\n', '# Sage\n\n- One\n- Two\n- Three\n', { added: ['Two'], removed: [] }))
      .toEqual({ added: 1, removed: 0 })
    expect(notesUpdateOf('- One\n', '- One\n- Two\n', { added: ['Two'], removed: [] })).toBeUndefined()
  })
})

const remembering: AgentConfig = { ...sage, memoryScope: true }
const other: AgentConfig = { ...smith, memoryScope: true }
const forgetting: AgentConfig = { ...smith, id: 'ada', name: 'Ada', memoryScope: false }
const today = localDate(new Date())

async function setup(kind: 'dm' | 'pair' = 'dm') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manor-agent-notes-'))
  const seeded = createMemoryStore({ agents: [remembering, other, forgetting] })
  const { chatId } = await seededChat(seeded)
  const chat = (await seeded.getChat(chatId))!
  const store = { appendEvent: seeded.appendEvent.bind(seeded), getChat: async () => ({ ...chat, kind }) }
  const events: ThreadEvent[] = []
  const writer = new AgentNotesWriter({
    store,
    memoryTarget: { dailyDir: path.join(root, 'memory', 'daily') },
    agents: () => [remembering, other, forgetting],
    emit: (message) => { if (message.type === 'event') events.push(message.event) },
    isActiveTurn: () => true,
  })
  const context = (agentId = 'sage') => ({ chatId, agentId, turnId: 'turn_1' })
  const agents = path.join(root, 'memory', 'agents')
  /** The system note a write left, which carries what Undo needs. */
  const lastWrite = () => {
    const note = events.filter((event) => event.type === 'system_note' && event.projectFileWrite !== undefined).at(-1)
    if (note?.type !== 'system_note' || note.projectFileWrite === undefined) throw new Error('no write recorded')
    return note.projectFileWrite
  }
  return { writer, context, agents, notes: path.join(agents, 'sage.md'), lastWrite }
}

describe('update_notes', () => {
  it('refuses a line over 300 characters with its date and a multi-line one, and writes nothing', async () => {
    const s = await setup()
    const dated = ` (${today})`
    await expect(s.writer.write(s.context(), { action: 'add', line: 'a'.repeat(301 - dated.length) })).rejects.toThrow('at most 300 characters')
    await expect(s.writer.write(s.context(), { action: 'add', line: 'one\ntwo' })).rejects.toThrow('one line')
    await expect(readFile(s.notes, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // The longest line that still fits lands, in its own file only.
    await s.writer.write(s.context(), { action: 'add', line: 'a'.repeat(300 - dated.length) })
    expect(await readFile(s.notes, 'utf8')).toContain(`- ${'a'.repeat(300 - dated.length)}${dated}`)
    expect(await readdir(s.agents)).toEqual(['sage.md'])
    expect(s.lastWrite()).toMatchObject({ action: 'add', agentId: 'sage', file: 'sage.md' })
  })

  it('notes softly past 20 lines, and the write still lands', async () => {
    const s = await setup()
    for (let index = 1; index <= 20; index += 1) {
      expect(await s.writer.write(s.context(), { action: 'add', line: `Rule ${index}` })).toBe('Saved in your notes.')
    }
    const result = await s.writer.write(s.context(), { action: 'add', line: 'Rule 21' })
    expect(result).toContain('now hold 21 lines')
    expect(await readFile(s.notes, 'utf8')).toContain('- Rule 21')
  })

  it('refuses a write from a talk between agents and creates no file', async () => {
    const s = await setup('pair')
    await expect(s.writer.write(s.context(), { action: 'add', line: 'Anything' })).rejects.toThrow('only from a DM or a group')
    await expect(readdir(s.agents)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an agent with memory off and creates no file', async () => {
    const s = await setup()
    await expect(s.writer.write(s.context('ada'), { action: 'add', line: 'Anything' })).rejects.toThrow('Memory is off for you')
    await expect(readdir(s.agents)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps what the tool wrote for the turn-end check, once', async () => {
    const s = await setup()
    await s.writer.write(s.context(), { action: 'add', line: 'Write in Dutch' })
    expect(s.writer.takeTurnWrites('turn_1')).toEqual({ added: [`Write in Dutch (${today})`], removed: [] })
    expect(s.writer.takeTurnWrites('turn_1')).toEqual({ added: [], removed: [] })
  })

  it('redoes a write on the file as a hand edit left it', async () => {
    const s = await setup()
    await s.writer.write(s.context(), { action: 'add', line: 'First' })
    const original = projectFiles.writeThreadFile
    let raced = false
    const spy = vi.spyOn(projectFiles, 'writeThreadFile').mockImplementation(async (file, content, expected) => {
      if (!raced) {
        raced = true
        await writeFile(file, `${await readFile(file, 'utf8')}- Typed by hand\n`)
      }
      return original(file, content, expected)
    })
    try {
      await s.writer.write(s.context(), { action: 'add', line: 'Second' })
    } finally {
      spy.mockRestore()
    }
    const content = await readFile(s.notes, 'utf8')
    expect(content).toContain('- Typed by hand')
    expect(content).toContain(`- Second (${today})`)
  })

  describe('undo of one write', () => {
    it('removes the line an add wrote', async () => {
      const s = await setup()
      await s.writer.write(s.context(), { action: 'add', line: 'Write in Dutch' })
      expect(s.lastWrite().writeId).toBeDefined()
      expect(await s.writer.undoWrite(s.lastWrite())).toBeUndefined()
      expect(await readFile(s.notes, 'utf8')).not.toContain('Write in Dutch')
    })

    it('restores the old line after a replace', async () => {
      const s = await setup()
      await s.writer.write(s.context(), { action: 'add', line: 'Write in Dutch' })
      await s.writer.write(s.context(), { action: 'replace', old: 'Write in Dutch', line: 'Write in English' })
      expect(await s.writer.undoWrite(s.lastWrite())).toBeUndefined()
      const content = await readFile(s.notes, 'utf8')
      expect(content).toContain(`- Write in Dutch (${today})`)
      expect(content).not.toContain('Write in English')
    })

    it('is refused when the line or its date was changed by hand in between', async () => {
      const s = await setup()
      await s.writer.write(s.context(), { action: 'add', line: 'Write in Dutch' })
      const write = s.lastWrite()
      await writeFile(s.notes, (await readFile(s.notes, 'utf8')).replace(`(${today})`, '(2020-01-01)'))
      expect(await s.writer.undoWrite(write)).toContain('Nothing was undone')
      expect(await readFile(s.notes, 'utf8')).toContain('- Write in Dutch (2020-01-01)')
    })
  })
})
