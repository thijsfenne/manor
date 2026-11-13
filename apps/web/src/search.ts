import {
  searchExcerpt,
  searchMatchKind,
  searchWords,
  type Reminder,
  type ReminderList,
  type SearchMatchKind,
  type SearchMessageHit,
  type SearchNoteHit,
} from '@manor/contracts'

/**
 * The ⌘K palette's one ranked list, across chats, messages, notes and reminders.
 *
 * The rule, in order:
 * 1. A title the query spells exactly (case, accents and spacing aside).
 * 2. A title that starts with the query.
 * 3. A title that holds every query word.
 * 4. A body that holds the query's words together, in order: a message, a note's
 *    text, a reminder's notes.
 * 5. A body that holds every query word, scattered.
 * Within one step the most recent wins: a chat's last message, a message's time, a
 * note's last save, a reminder's creation.
 *
 * Words match where a word starts ("plan" finds "planning", "cafe" finds "Café"),
 * the same rule the server's message index applies, so what ranks is what is marked.
 * A message is a body hit by definition; its chat title is context, not the match.
 */
export const SEARCH_RESULT_LIMIT = 40

/** 0 is the strongest match; see the rule above. */
export type SearchTier = 0 | 1 | 2 | 3 | 4

export type SearchResult = (
  | { kind: 'chat'; chatId: string; title: string; projectName: string }
  | { kind: 'message'; chatId: string; eventId: string; chatTitle: string; projectName: string; agentId?: string; snippet: string }
  | { kind: 'note'; path: string; title: string; folder: string; snippet?: string }
  | { kind: 'reminder'; reminderId: string; listId: string; title: string; listTitle: string; snippet?: string }
) & { key: string; tier: SearchTier; at: number }

export interface SearchChat {
  chatId: string
  title: string
  projectName: string
  lastMessageAt: number
}

export interface SearchSources {
  /** Every chat the client lists; message hits outside it are dropped, they could not open. */
  chats: readonly SearchChat[]
  messages: readonly SearchMessageHit[]
  notes: readonly SearchNoteHit[]
  reminders: readonly Reminder[]
  lists: readonly ReminderList[]
}

const TITLE_TIER: Record<SearchMatchKind, SearchTier> = { exact: 0, prefix: 1, phrase: 2, words: 2 }
const bodyTier = (kind: SearchMatchKind | null | boolean): SearchTier | null =>
  kind === null || kind === false ? null : kind === 'words' ? 4 : 3

export function rankSearchResults(query: string, sources: SearchSources): SearchResult[] {
  const words = searchWords(query)
  if (words.length === 0) return []
  const results: SearchResult[] = []
  const chats = new Map(sources.chats.map((chat) => [chat.chatId, chat]))
  const titleTier = (title: string) => {
    const kind = searchMatchKind(title, words)
    return kind === null ? null : TITLE_TIER[kind]
  }

  for (const chat of sources.chats) {
    const tier = titleTier(chat.title)
    if (tier === null) continue
    results.push({ kind: 'chat', key: `chat:${chat.chatId}`, chatId: chat.chatId, title: chat.title, projectName: chat.projectName, tier, at: chat.lastMessageAt })
  }

  for (const hit of sources.messages) {
    const chat = chats.get(hit.chatId)
    if (chat === undefined) continue
    results.push({
      kind: 'message',
      key: `message:${hit.chatId}:${hit.eventId}`,
      chatId: hit.chatId,
      eventId: hit.eventId,
      chatTitle: chat.title,
      projectName: chat.projectName,
      ...(hit.agentId === undefined ? {} : { agentId: hit.agentId }),
      snippet: hit.snippet,
      tier: hit.phrase ? 3 : 4,
      at: hit.ts,
    })
  }

  for (const note of sources.notes) {
    // The server sends only notes that matched; one without a title match matched in its text.
    const tier = titleTier(note.title) ?? (note.phrase ? 3 : 4)
    const folder = note.path.split('/').slice(0, -1).join('/')
    results.push({
      kind: 'note',
      key: `note:${note.path}`,
      path: note.path,
      title: note.title,
      folder,
      ...(note.snippet === undefined ? {} : { snippet: note.snippet }),
      tier,
      at: note.modifiedAt,
    })
  }

  const listTitles = new Map(sources.lists.map((list) => [list.id, list.title]))
  for (const reminder of sources.reminders) {
    const notes = reminder.notes ?? ''
    const tier = titleTier(reminder.title) ?? bodyTier(searchMatchKind(notes, words))
    if (tier === null) continue
    const snippet = notes.trim() === '' ? undefined : searchExcerpt(notes, words) ?? notes.replace(/\s+/g, ' ').trim()
    const created = reminder.createdAt === undefined ? Number.NaN : Date.parse(reminder.createdAt)
    results.push({
      kind: 'reminder',
      key: `reminder:${reminder.id}`,
      reminderId: reminder.id,
      listId: reminder.listId,
      title: reminder.title,
      listTitle: listTitles.get(reminder.listId) ?? '',
      ...(snippet === undefined ? {} : { snippet }),
      tier,
      at: Number.isFinite(created) ? created : 0,
    })
  }

  return results.sort((a, b) => a.tier - b.tier || b.at - a.at).slice(0, SEARCH_RESULT_LIMIT)
}
