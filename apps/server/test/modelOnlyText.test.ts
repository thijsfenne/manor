import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { modelTextOf, type ThreadEvent } from '@manor/contracts'
import { renderCatchUpEvents } from '../src/composer.js'
import { createSqliteStore } from '../src/stores/sqliteStore.js'
import { SqliteRecords } from '../src/stores/sqliteDatabase.js'
import { sage } from './helpers.js'

type Stored = ReturnType<typeof createSqliteStore>
const directories: string[] = []
const opened: Stored[] = []
afterEach(() => {
  for (const store of opened.splice(0)) try { store.close() } catch { /* closed by the test */ }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const fixture = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'manor-model-only-'))
  directories.push(directory)
  const filename = path.join(directory, 'manor.sqlite')
  const store = createSqliteStore({ filename, agents: [sage], seed: true })
  opened.push(store)
  return { store, filename }
}

const OPENING = '[Manor] Session accepted as Single with claude-opus-5-5. Complete the task below in this session.\n\n'
const TASK = 'Fix the border on the card.'
const kickoff = { type: 'user_message' as const, mentions: [], source: 'work_handoff' as const, workHandoffId: 'h1', workSourceChatId: 'c1' }

describe('Manor wording for the model, kept out of what the user reads', () => {
  it('previews and searches the task, and leaves a request that is all instruction out of both', async () => {
    const { store } = fixture()
    const chat = (await store.listChats())[0]!
    await store.appendEvent(chat.id, { ...kickoff, text: TASK, instruction: OPENING })
    expect((await store.listChats()).find((row) => row.id === chat.id)?.lastMessagePreview).toBe(TASK)
    // Confirm's commit request and a merge report are Manor talking to the model: the line stays.
    await store.appendEvent(chat.id, { type: 'user_message', text: '', instruction: '[Manor] The user confirmed the ready result, and that is their approval to commit.', mentions: [] })
    expect((await store.listChats()).find((row) => row.id === chat.id)?.lastMessagePreview).toBe(TASK)
    const options = { chatIds: [chat.id], perChat: 5, limit: 10 }
    expect(await store.searchMessages('border', options)).toHaveLength(1)
    expect(await store.searchMessages('accepted', options)).toEqual([])
    expect(await store.searchMessages('confirmed', options)).toEqual([])
  })

  it('hands the model the same text as before the instruction had a field of its own', async () => {
    const { store } = fixture()
    const chat = (await store.listChats())[0]!
    const moved = await store.appendEvent(chat.id, { ...kickoff, text: TASK, instruction: OPENING })
    const before = { ...moved, text: `${OPENING}${TASK}` } as ThreadEvent
    delete (before as { instruction?: string }).instruction
    expect(modelTextOf(moved as Extract<ThreadEvent, { type: 'user_message' }>)).toBe(`${OPENING}${TASK}`)
    expect(renderCatchUpEvents([moved], [sage])).toBe(renderCatchUpEvents([before], [sage]))
    expect(renderCatchUpEvents([moved], [sage])).toContain('[Manor] Session accepted as Single with claude-opus-5-5.')
  })

  it('moves what older versions stored into the new shape without changing what the model reads', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]!
    // Rows as they were written before `instruction`: Manor's wording inside `text`.
    const old: Parameters<Stored['appendEvent']>[1][] = [
      { ...kickoff, text: `${OPENING}${TASK}` },
      { type: 'user_message', mentions: [], source: 'project_thread', threadReason: 'report', text: '[Manor] Reports for this project: a note about gradients.' },
      { type: 'user_message', mentions: [], source: 'project_thread', threadReason: 'brief', text: '[Manor] Smith handed this brief over.\nTask:\nFix the fluorescent border.' },
      { type: 'user_message', mentions: [], text: '[Manor] The user confirmed the ready result, and that is their approval to commit. Commit it.' },
      { type: 'user_message', mentions: [], text: '[Manor] is a name I typed myself, about shadows.' },
    ]
    for (const event of old) await store.appendEvent(chat.id, event)
    // The line the old server kept, which the cut-off task never reached.
    new SqliteRecords(store.db, 'transcriptMetadata').set(chat.id, { preview: OPENING.trim().slice(0, 90), participants: {} })
    store.db.exec('PRAGMA user_version = 11')
    store.close()

    const options = { chatIds: [chat.id], perChat: 5, limit: 10 }
    {
      const migrated = createSqliteStore({ filename })
      opened.push(migrated)
      const stored = (await migrated.loadEvents(chat.id)).filter((event) => event.type === 'user_message')
      // The model reads the same string as before, whichever field holds it.
      expect(stored.map(modelTextOf)).toEqual(old.map((event) => (event as { text: string }).text))
      expect((await migrated.listChats()).find((row) => row.id === chat.id)?.lastMessagePreview).toBe('[Manor] is a name I typed myself, about shadows.')
      expect(await migrated.searchMessages('border', options)).toHaveLength(2)
      expect(await migrated.searchMessages('fluorescent', options)).toHaveLength(1)
      expect(await migrated.searchMessages('accepted', options)).toEqual([])
      expect(await migrated.searchMessages('gradients', options)).toEqual([])
      expect(await migrated.searchMessages('shadows', options)).toHaveLength(1)
      // A later update of a moved row (Confirm's dispatch state) must not bring its wording back.
      const confirm = stored.find((event) => event.type === 'user_message' && event.text === '' && event.instruction?.includes('The user confirmed'))!
      await migrated.replaceEvent(chat.id, confirm)
      expect(await migrated.searchMessages('confirmed', options)).toEqual([])
    }
  })
})
