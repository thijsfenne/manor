import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '@manor/contracts'
import { SQLITE_SCHEMA_VERSION } from '../src/stores/sqliteDatabase.js'
import { createSqliteStore } from '../src/stores/sqliteStore.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { messageSearchExpressions } from '../src/stores/sqliteTranscript.js'
import { SearchModule } from '../src/searchModule.js'
import { openVault } from '../src/vault.js'
import { sage } from './helpers.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const tempDir = (prefix: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix))
  directories.push(directory)
  return directory
}

const say = (text: string) => ({ type: 'user_message' as const, text, mentions: [] })
const reply = (text: string) => ({ type: 'agent_message' as const, agentId: 'sage', turnId: 't1', text })
const options = (chatIds: string[], limit = 40) => ({ chatIds, perChat: 2, limit })

async function storeWithChats(count: number) {
  const store = createMemoryStore({ agents: [sage] })
  const chats = []
  for (let index = 0; index < count; index += 1) chats.push(await store.createChat({ kind: 'project', projectId: (await store.listProjects())[0]!.id, title: `Chat ${index}` }))
  return { store, chats }
}

describe('message search', () => {
  it('finds word prefixes across diacritics in what the user and personas wrote, and says who wrote it', async () => {
    const { store, chats } = await storeWithChats(1)
    const chat = chats[0]!
    const mine = await store.appendEvent(chat.id, say('Shall we meet at the Café Brandstof?'))
    const theirs = await store.appendEvent(chat.id, reply('Planning the offsite for Thursday.'))
    await store.appendEvent(chat.id, { type: 'system_note', kind: 'info', text: 'cafe planning note' })

    const cafe = await store.searchMessages('cafe', options([chat.id]))
    expect(cafe).toEqual([expect.objectContaining({ chatId: chat.id, eventId: mine.id, phrase: true })])
    expect(cafe[0]).not.toHaveProperty('agentId')
    expect(cafe[0]?.snippet).toContain('Café Brandstof')

    expect(await store.searchMessages('plan', options([chat.id]))).toEqual([
      expect.objectContaining({ eventId: theirs.id, agentId: 'sage', ts: theirs.ts }),
    ])
    // A word that only appears inside another word is not a prefix match.
    expect(await store.searchMessages('ning', options([chat.id]))).toEqual([])
  })

  it('ranks phrase hits first, keeps at most two per chat, and searches only the chats it is given', async () => {
    const { store, chats } = await storeWithChats(3)
    const [long, other, hidden] = chats as [typeof chats[0], typeof chats[0], typeof chats[0]]
    const phrase = await store.appendEvent(long.id, say('the release notes are ready'))
    await store.appendEvent(long.id, say('notes about the release'))
    const newest = await store.appendEvent(long.id, say('release day, notes later'))
    const scattered = await store.appendEvent(other.id, say('notes first, then the release'))
    await store.appendEvent(hidden.id, say('release notes in a side chat'))

    const hits = await store.searchMessages('release notes', options([long.id, other.id]))
    // The phrase hit leads; the long chat's two survivors are its phrase hit and its newest.
    expect(hits.map((hit) => [hit.eventId, hit.chatId, hit.phrase])).toEqual([
      [phrase.id, long.id, true],
      [scattered.id, other.id, false],
      [newest.id, long.id, false],
    ])
    // Each hit's excerpt comes from its own message.
    expect(hits.map((hit) => hit.snippet)).toEqual(['the release notes are ready', 'notes first, then the release', 'release day, notes later'])
    expect(await store.searchMessages('release notes', options([long.id, other.id], 1))).toHaveLength(1)
  })

  it('follows replaced and deleted events, and leaves Manor wake rows out', async () => {
    const { store, chats } = await storeWithChats(1)
    const chat = chats[0]!
    const event = await store.appendEvent(chat.id, reply('draft answer'))
    await store.appendEvent(chat.id, { ...say('Background work ended: draft'), source: 'background_wake' })
    expect(await store.searchMessages('draft', options([chat.id]))).toEqual([expect.objectContaining({ eventId: event.id })])

    if (event.type !== 'agent_message') throw new Error('expected a reply')
    await store.replaceEvent(chat.id, { ...event, text: 'final answer' })
    expect(await store.searchMessages('draft', options([chat.id]))).toEqual([])
    expect(await store.searchMessages('final', options([chat.id]))).toHaveLength(1)

    await store.deleteChat(chat.id)
    expect(await store.searchMessages('final', options([chat.id]))).toEqual([])
  })

  it('reads typed FTS syntax as plain words', async () => {
    const { store, chats } = await storeWithChats(1)
    await store.appendEvent(chats[0]!.id, say('cats OR dogs'))
    expect(messageSearchExpressions('"cats" OR NEAR(dogs')).toEqual({ match: '"cats"* "or"* "near"* "dogs"*', phrase: '"cats or near dogs"*' })
    expect(messageSearchExpressions('  — ')).toBeNull()
    expect(await store.searchMessages('cats OR', options([chats[0]!.id]))).toHaveLength(1)
    expect(await store.searchMessages('"', options([chats[0]!.id]))).toEqual([])
  })

  it('indexes the messages a database already held when it migrates', async () => {
    const filename = path.join(tempDir('manor-search-'), 'manor.db')
    const store = createSqliteStore({ filename, seed: true, agents: [sage] })
    const chat = (await store.listChats())[0]!
    await store.appendEvent(chat.id, say('remember the quarterly budget'))
    // Back to the version before the index, as a live database is today.
    store.db.exec(`DROP TRIGGER message_search_insert; DROP TRIGGER message_search_update; DROP TRIGGER message_search_delete;
      DROP TABLE message_search; PRAGMA user_version = 9;`)
    store.close()
    const reopened = createSqliteStore({ filename })
    try {
      expect(reopened.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SQLITE_SCHEMA_VERSION)
      expect(await reopened.searchMessages('quarterly budget', options([chat.id]))).toEqual([expect.objectContaining({ phrase: true })])
    } finally {
      reopened.close()
    }
  })
})

describe('search module', () => {
  it('answers with message hits from listed chats and note hits, titles before bodies', async () => {
    const { store, chats } = await storeWithChats(1)
    await store.appendEvent(chats[0]!.id, say('the garden plan is due'))
    const root = tempDir('manor-vault-')
    mkdirSync(path.join(root, 'projects'))
    writeFileSync(path.join(root, 'projects', 'Garden plan.md'), '# Garden\nBeds and seeds.')
    writeFileSync(path.join(root, 'Weekly review.md'), '---\ntags: [week]\n---\n# Week\n- [x] Spent the morning on the **garden plan** with Anna.')
    writeFileSync(path.join(root, 'Recipes.md'), 'Nothing about it here.')
    // The body hit is newer, and still ranks under the title hit.
    utimesSync(path.join(root, 'projects', 'Garden plan.md'), new Date(2026, 0, 1), new Date(2026, 0, 1))
    const opened = await openVault(root)
    if (!opened.ok) throw new Error(opened.message)

    const replies: ServerMessage[] = []
    await new SearchModule({ store, vault: opened.vault }).handle({ type: 'search', requestId: 'r1', query: 'garden plan' }, (message) => replies.push(message))

    expect(replies).toEqual([{
      type: 'search_results',
      requestId: 'r1',
      query: 'garden plan',
      messages: [expect.objectContaining({ chatId: chats[0]!.id, phrase: true })],
      notes: [
        expect.objectContaining({ path: 'projects/Garden plan.md', title: 'Garden plan' }),
        expect.objectContaining({ path: 'Weekly review.md', title: 'Weekly review', phrase: true, snippet: 'Week Spent the morning on the garden plan with Anna.' }),
      ],
    }])
  })

  it('keeps an older exact title above twenty newer titles that only start with it', async () => {
    const { store } = await storeWithChats(1)
    const root = tempDir('manor-vault-')
    writeFileSync(path.join(root, 'Budget.md'), 'Old.')
    utimesSync(path.join(root, 'Budget.md'), new Date(2020, 0, 1), new Date(2020, 0, 1))
    for (let index = 0; index < 21; index += 1) writeFileSync(path.join(root, `Budget review ${index}.md`), 'New.')
    const opened = await openVault(root)
    if (!opened.ok) throw new Error(opened.message)

    const replies: ServerMessage[] = []
    await new SearchModule({ store, vault: opened.vault }).handle({ type: 'search', requestId: 'r1', query: 'budget' }, (message) => replies.push(message))

    const reply = replies[0]
    if (reply?.type !== 'search_results') throw new Error('no results')
    expect(reply.notes).toHaveLength(20)
    expect(reply.notes[0]).toEqual(expect.objectContaining({ path: 'Budget.md' }))
  })
})
