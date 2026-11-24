import { describe, expect, it } from 'vitest'
import type { Reminder } from '@manor/contracts'
import { searchExcerpt, searchMatches, searchMatchKind, searchWords } from '@manor/contracts'
import { rankSearchResults, type SearchSources } from './searchRanking'

const reminder = (id: string, title: string, extra: Partial<Reminder> = {}): Reminder => ({
  id, title, listId: 'todo', completed: false, flagged: false, priority: 'none', tags: [], ...extra,
})

const empty: SearchSources = { chats: [], messages: [], notes: [], reminders: [], lists: [] }

describe('palette ranking', () => {
  it('puts exact, then starting, then containing titles above body matches, newest first within a step', () => {
    const results = rankSearchResults('budget', {
      chats: [
        { chatId: 'c-old', title: 'Budget', projectName: 'Home', lastMessageAt: 1 },
        { chatId: 'c-start', title: 'Budget review Q4', projectName: '', lastMessageAt: 50 },
        { chatId: 'c-contains', title: 'Yearly budget', projectName: '', lastMessageAt: 90 },
        { chatId: 'c-none', title: 'Groceries', projectName: '', lastMessageAt: 99 },
      ],
      messages: [
        { chatId: 'c-none', eventId: 'evt_2', ts: 200, snippet: 'the budget is tight', phrase: true },
        { chatId: 'c-none', eventId: 'evt_1', ts: 100, snippet: 'budgets later', phrase: true },
        { chatId: 'gone', eventId: 'evt_9', ts: 300, snippet: 'budget', phrase: true },
      ],
      notes: [{ path: 'money/Budget.md', title: 'Budget', phrase: false, modifiedAt: 10 }],
      reminders: [reminder('r1', 'Pay rent', { notes: 'check the budget first', createdAt: '2026-10-01T09:00:00Z' })],
      lists: [{ id: 'todo', title: 'To do', shared: false, open: 1, sections: [], sharees: [] }],
    })
    expect(results.map((result) => [result.key, result.tier])).toEqual([
      // Exact titles: the note was saved after the chat's last message.
      ['note:money/Budget.md', 0],
      ['chat:c-old', 0],
      ['chat:c-start', 1],
      ['chat:c-contains', 2],
      // Body hits, the reminder created most recently; a message from an unlisted chat is gone.
      ['reminder:r1', 3],
      ['message:c-none:evt_2', 3],
      ['message:c-none:evt_1', 3],
    ])
    expect(results.find((result) => result.kind === 'reminder')).toMatchObject({ listTitle: 'To do', snippet: 'check the budget first' })
  })

  it('ranks a phrase above the same words scattered, and returns nothing for a query without words', () => {
    const sources: SearchSources = {
      ...empty,
      chats: [{ chatId: 'c', title: 'Planning', projectName: '', lastMessageAt: 0 }],
      messages: [
        { chatId: 'c', eventId: 'evt_new', ts: 9, snippet: 'notes then the release', phrase: false },
        { chatId: 'c', eventId: 'evt_old', ts: 1, snippet: 'release notes', phrase: true },
      ],
    }
    expect(rankSearchResults('release notes', sources).map((result) => [result.key, result.tier])).toEqual([
      ['message:c:evt_old', 3],
      ['message:c:evt_new', 4],
    ])
    expect(rankSearchResults(' — ', sources)).toEqual([])
  })
})

describe('project threads in the palette', () => {
  const chats = [{ chatId: 'thread', title: 'Küche', projectName: '', lastMessageAt: 5 }]

  it('finds a project thread by its project name, accents aside', () => {
    expect(rankSearchResults('kuche', { ...empty, chats }).map((result) => result.key)).toEqual(['chat:thread'])
  })

  it('keeps a message said in a thread, and drops one from a chat the list lacks', () => {
    const hit = (chatId: string, eventId: string) => ({ chatId, eventId, ts: 9, snippet: 'Corners are always square', phrase: true })
    const found = rankSearchResults('corners are', { ...empty, chats, messages: [hit('thread', 'e1'), hit('gone', 'e2')] })
    expect(found.map((result) => result.key)).toEqual(['message:thread:e1'])
  })
})

describe('search text matching', () => {
  it('matches word starts across case and accents, and marks them in the original text', () => {
    const words = searchWords('Cafe  PLAN')
    expect(words).toEqual(['cafe', 'plan'])
    expect(searchMatchKind('Café plannen', words)).toBe('prefix')
    expect(searchMatchKind('Het Café plannen', words)).toBe('phrase')
    expect(searchMatchKind('plan het café', words)).toBe('words')
    expect(searchMatchKind('cafe plan', words)).toBe('exact')
    expect(searchMatchKind('replanned café', words)).toBeNull()
    const text = 'Naar het Café om te plannen'
    expect(searchMatches(text, words).map(([start, end]) => text.slice(start, end))).toEqual(['Café', 'plan'])
  })

  it('cuts an excerpt at word edges around the first match', () => {
    const text = `${'word '.repeat(40)}the budget meeting ${'tail '.repeat(40)}`
    const excerpt = searchExcerpt(text, ['budget'], 12, 20)
    expect(excerpt).toBe('…word the budget meeting tail tail…')
    expect(searchExcerpt('nothing here', ['budget'])).toBeUndefined()
  })
})
