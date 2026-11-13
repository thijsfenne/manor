import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  searchExcerpt,
  searchMatchKind,
  searchWords,
  type ClientMessage,
  type SearchNoteHit,
  type ServerMessage,
} from '@manor/contracts'
import type { Store } from './store.js'
import { isDirectoryChat } from './projectModule.js'
import { listVaultFiles, readVaultFile, type Vault } from './vault.js'

type SearchMessage = Extract<ClientMessage, { type: 'search' }>

/**
 * At most two hits from one chat, so one long Session cannot fill the palette, and
 * forty in all: more than the palette shows once chats, notes and reminders join them.
 */
export const MESSAGE_HITS_PER_CHAT = 2
export const MESSAGE_HIT_LIMIT = 40
const NOTE_HIT_LIMIT = 20

/**
 * How long one read of the vault answers searches. Typing a query is a burst of
 * requests; reading 370 notes once per burst rather than once per keystroke keeps
 * every answer fast, and a note saved a few seconds ago is found on the next burst.
 */
const NOTE_CORPUS_TTL_MS = 15_000

interface Note { path: string; title: string; body: string; modifiedAt: number }

/**
 * The ⌘K palette's server half. Messages come from the store's full-text index;
 * notes from the vault through the same listing and reading the Knowledge view uses.
 * Chat titles and reminders are matched on the client, which already holds them.
 */
export class SearchModule {
  private notes: { loadedAt: number; notes: Promise<Note[]> } | null = null
  /** Bodies by path, reread only when the file's modification time moves. */
  private bodies = new Map<string, { modifiedAt: number; body: string }>()

  constructor(private options: { store: Pick<Store, 'listChats' | 'searchMessages'>; vault?: Vault; now?: () => number }) {}

  async handle(message: SearchMessage, reply: (message: ServerMessage) => void): Promise<void> {
    const [chats, notes] = await Promise.all([this.options.store.listChats(), this.searchNotes(message.query)])
    const messages = await this.options.store.searchMessages(message.query, {
      chatIds: chats.filter(isDirectoryChat).map((chat) => chat.id),
      perChat: MESSAGE_HITS_PER_CHAT,
      limit: MESSAGE_HIT_LIMIT,
    })
    reply({ type: 'search_results', requestId: message.requestId, query: message.query, messages, notes })
  }

  /**
   * Ranked with the palette's own tiers before the cut to twenty, so an older exact title
   * is never pushed out by newer notes that only start with it: exact title, title prefix,
   * other title match, body phrase, scattered body words; newest first within a tier.
   */
  private async searchNotes(query: string): Promise<SearchNoteHit[]> {
    const words = searchWords(query)
    if (words.length === 0 || this.options.vault === undefined) return []
    const hits: Array<SearchNoteHit & { rank: number }> = []
    for (const note of await this.corpus(this.options.vault)) {
      const title = searchMatchKind(note.title, words)
      const body = searchMatchKind(note.body, words)
      if (title === null && body === null) continue
      const snippet = body === null ? undefined : searchExcerpt(readableNote(note.body), words)
      hits.push({
        path: note.path,
        title: note.title,
        ...(snippet === undefined ? {} : { snippet }),
        phrase: body === 'exact' || body === 'prefix' || body === 'phrase',
        modifiedAt: note.modifiedAt,
        rank: title === 'exact' ? 0 : title === 'prefix' ? 1 : title !== null ? 2 : body === 'words' ? 4 : 3,
      })
    }
    return hits
      .sort((a, b) => a.rank - b.rank || b.modifiedAt - a.modifiedAt)
      .slice(0, NOTE_HIT_LIMIT)
      .map(({ rank: _rank, ...hit }) => hit)
  }

  private corpus(vault: Vault): Promise<Note[]> {
    const now = (this.options.now ?? Date.now)()
    if (this.notes !== null && now - this.notes.loadedAt < NOTE_CORPUS_TTL_MS) return this.notes.notes
    const notes = this.readCorpus(vault)
    this.notes = { loadedAt: now, notes }
    // A failed read is not kept: the next keystroke tries again.
    notes.catch(() => { if (this.notes?.notes === notes) this.notes = null })
    return notes
  }

  private async readCorpus(vault: Vault): Promise<Note[]> {
    const { files } = await listVaultFiles(vault)
    const notes: Note[] = []
    const seen = new Set<string>()
    let next = 0
    // Bounded like the listing's own previews: the vault sits on iCloud Drive.
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next++] as string
        seen.add(file)
        const modifiedAt = await stat(path.join(vault.root, file)).then((info) => info.mtimeMs, () => null)
        if (modifiedAt === null) continue
        let body = this.bodies.get(file)?.modifiedAt === modifiedAt ? this.bodies.get(file)?.body : undefined
        if (body === undefined) {
          const read = await readVaultFile(vault, file)
          if (read.status !== 'ready') continue
          body = read.content
          this.bodies.set(file, { modifiedAt, body })
        }
        notes.push({ path: file, title: noteTitle(file), body, modifiedAt })
      }
    }))
    for (const file of this.bodies.keys()) if (!seen.has(file)) this.bodies.delete(file)
    return notes
  }
}

/**
 * A note's text as it reads, for its snippet: front matter, heading marks, list and
 * quote markers, task boxes and emphasis go, so a line reads as the sentence it is.
 * Matching still runs on the file as written; only the excerpt is cleaned.
 */
export function readableNote(body: string): string {
  return body
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, '')
    .replace(/\*\*|__|`/g, '')
}

/** The name a note goes by in the tree: its file name without `.md`. */
export function noteTitle(file: string): string {
  return (file.split('/').at(-1) ?? file).replace(/\.md$/i, '')
}
