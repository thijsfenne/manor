import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { planProgress, searchWords, type EventSync, type PlanProgress, type SearchMessageHit, type ThreadEvent } from '@manor/contracts'
import type { SkillBundleFile, UnresolvedOutboundSubmission } from '../store.js'
import { previewLine } from './previewLine.js'
import { foldUsageEvent, usageRunKey, type UsageRun } from '../usageReport.js'
import { SqliteRecords } from './sqliteDatabase.js'

type Metadata = { preview: string | null; participants: Record<string, number>; plan?: PlanProgress }

/** How many rewrites of one chat stay nameable. A client further behind gets the whole thread. */
const REWRITE_LOG = 256

export class SqliteTranscript {
  private cache = new Map<string, { events: ThreadEvent[]; bytes: number }>()
  private dataVersion = -1
  /**
   * Which events were rewritten in place, per chat, since this process started. A
   * client that was away asks with the position it last saw and gets those events
   * again. Memory only: a restart changes `epoch`, and every older position then
   * reads as unknown.
   */
  private epoch = randomUUID()
  private rewrites = new Map<string, { rev: number; log: { rev: number; id: string }[] }>()
  private metadata: SqliteRecords<Metadata>
  private runs: SqliteRecords<UsageRun>
  private outbound: SqliteRecords<UnresolvedOutboundSubmission>
  constructor(private db: DatabaseSync) {
    this.metadata = new SqliteRecords(db, 'transcriptMetadata')
    this.runs = new SqliteRecords(db, 'usageRuns')
    this.outbound = new SqliteRecords(db, 'outboundSubmissions')
  }
  create(chatId: string): void {
    this.metadata.set(chatId, { preview: null, participants: {} })
  }
  clearCache(): void { this.cache.clear() }
  private trimCache(): void {
    let bytes = [...this.cache.values()].reduce((total, row) => total + row.bytes, 0)
    while (this.cache.size > 32 || bytes > 32 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      bytes -= this.cache.get(oldest)?.bytes ?? 0
      this.cache.delete(oldest)
    }
  }
  get(chatId: string): ThreadEvent[] {
    const version = Number(this.db.prepare('PRAGMA data_version').get()?.data_version)
    // Another connection wrote. What it rewrote is unknown, so no older position holds.
    if (version !== this.dataVersion) { this.cache.clear(); this.rewrites.clear(); this.epoch = randomUUID(); this.dataVersion = version }
    const held = this.cache.get(chatId)
    if (held !== undefined) {
      this.cache.delete(chatId)
      this.cache.set(chatId, held)
      return held.events
    }
    const rows = this.db.prepare('SELECT payload FROM events WHERE chat_id = ? ORDER BY seq').all(chatId)
    const events = rows.map((row) => JSON.parse(String(row.payload)) as ThreadEvent)
    // UTF-16 plus object overhead is estimated conservatively; large transcripts are not retained.
    const bytes = rows.reduce((total, row) => total + String(row.payload).length * 4, 0)
    this.cache.set(chatId, { events, bytes })
    this.trimCache()
    return events
  }
  tail(chatId: string): ThreadEvent[] {
    const row = this.db.prepare('SELECT payload FROM events WHERE chat_id = ? ORDER BY CAST(substr(event_id, 5) AS INTEGER) DESC LIMIT 1').get(chatId)
    return row === undefined ? [] : [JSON.parse(String(row.payload)) as ThreadEvent]
  }
  append(chatId: string, event: ThreadEvent): void {
    this.db.prepare('INSERT INTO events(chat_id, event_id, payload) VALUES (?, ?, ?)').run(chatId, event.id, JSON.stringify(event))
    const cached = this.cache.get(chatId)
    if (cached !== undefined) { cached.events.push(event); cached.bytes += JSON.stringify(event).length * 4; this.trimCache() }
    const meta = this.metadata.get(chatId) ?? { preview: null, participants: {} }
    if ('agentId' in event && event.agentId !== undefined) meta.participants[event.agentId] = Math.max(meta.participants[event.agentId] ?? 0, event.ts)
    const line = previewLine(event)
    if (line !== undefined) meta.preview = line
    // A card with no lines draws nothing, so it leaves no count either.
    if (event.type === 'todo_update') {
      if (event.todos.length === 0) delete meta.plan
      else meta.plan = planProgress(event.todos)
    }
    this.metadata.set(chatId, meta)
    if (event.type === 'outbound_draft_submission') this.outbound.set(JSON.stringify([chatId, event.draftId]), { chatId, event })
    if (event.type !== 'turn_result' && event.type !== 'agent_message') return
    const key = usageRunKey(chatId, event.turnId, event.agentId)
    const run = foldUsageEvent(this.runs.get(key), chatId, event)
    if (run !== undefined) this.runs.set(key, run)
  }
  replace(chatId: string, event: ThreadEvent): void {
    const payload = JSON.stringify(event)
    const result = this.db.prepare('UPDATE events SET payload = ? WHERE chat_id = ? AND event_id = ?')
      .run(payload, chatId, event.id)
    if (result.changes === 0) throw new Error(`unknown event ${event.id}`)
    // Counted before anything can return early. A rewrite that is rolled back stays
    // counted, which only sends that event once more.
    const rewritten = this.rewrites.get(chatId) ?? { rev: 0, log: [] }
    rewritten.rev += 1
    rewritten.log.push({ rev: rewritten.rev, id: event.id })
    if (rewritten.log.length > REWRITE_LOG) rewritten.log.shift()
    this.rewrites.set(chatId, rewritten)
    const cached = this.cache.get(chatId)
    if (cached === undefined) return
    const index = cached.events.findIndex((held) => held.id === event.id)
    if (index === -1) return
    cached.bytes += payload.length * 4 - JSON.stringify(cached.events[index]).length * 4
    cached.events[index] = event
  }
  /** Where this chat's rewrites stand. Read it together with `get`, which can start a new epoch. */
  sync(chatId: string): EventSync {
    return { epoch: this.epoch, rev: this.rewrites.get(chatId)?.rev ?? 0 }
  }
  /**
   * Ids rewritten after `since`, or undefined when that cannot be told: the position
   * is from another run, was never handed out, or lies before what the log still holds.
   */
  rewrittenSince(chatId: string, since: EventSync): string[] | undefined {
    if (since.epoch !== this.epoch) return undefined
    const held = this.rewrites.get(chatId)
    const rev = held?.rev ?? 0
    if (since.rev === rev) return []
    if (held === undefined || since.rev > rev) return undefined
    const oldest = held.log[0]?.rev ?? rev + 1
    if (since.rev < oldest - 1) return undefined
    return [...new Set(held.log.filter((entry) => entry.rev > since.rev).map((entry) => entry.id))]
  }
  participants(chatId: string): string[] {
    return Object.entries(this.metadata.get(chatId)?.participants ?? {}).sort(([, a], [, b]) => b - a).map(([id]) => id)
  }
  /** What a chat's listing row says about its transcript, from one metadata read. */
  summary(chatId: string): { preview: string | null; plan?: PlanProgress } {
    const meta = this.metadata.get(chatId)
    return { preview: meta?.preview ?? null, ...(meta?.plan === undefined ? {} : { plan: meta.plan }) }
  }
  unresolved(): UnresolvedOutboundSubmission[] { return [...this.outbound.values()].filter(({ event }) => event.status === 'started') }
  usageRuns(): UsageRun[] { return [...this.runs.values()] }
  /**
   * Reads the `message_search` index that migration 010's triggers keep. Every query
   * word must match the start of a word in the message; a message holding the words
   * together in order is a phrase hit. Order is phrase hits first, then newest, both
   * for which two of a chat's hits survive the cap and for the overall cut.
   */
  searchMessages(query: string, options: { chatIds: readonly string[]; perChat: number; limit: number }): SearchMessageHit[] {
    const expressions = messageSearchExpressions(query)
    if (expressions === null || options.chatIds.length === 0) return []
    const rows = this.db.prepare(`
      WITH hits AS (
        SELECT rowid AS seq, chat_id,
          ${expressions.phrase === null ? '1' : 'rowid IN (SELECT rowid FROM message_search WHERE message_search MATCH :phrase)'} AS phrase
        FROM message_search
        WHERE message_search MATCH :match AND chat_id IN (SELECT value FROM json_each(:chats))
      ), ranked AS (
        SELECT seq, chat_id, phrase, row_number() OVER (PARTITION BY chat_id ORDER BY phrase DESC, seq DESC) AS nth FROM hits
      )
      SELECT ranked.seq, ranked.chat_id, ranked.phrase, events.event_id,
        json_extract(events.payload, '$.ts') AS ts, json_extract(events.payload, '$.agentId') AS agent_id
      FROM ranked JOIN events ON events.seq = ranked.seq
      WHERE ranked.nth <= :perChat
      ORDER BY ranked.phrase DESC, ranked.seq DESC
      LIMIT :limit
    `).all({
      match: expressions.match,
      ...(expressions.phrase === null ? {} : { phrase: expressions.phrase }),
      chats: JSON.stringify(options.chatIds),
      perChat: options.perChat,
      limit: options.limit,
    })
    // FTS picks the excerpt around the matched words; its markers are stripped because
    // the client marks words itself, the same way for every kind of result. The cast is
    // needed: node:sqlite binds a number as REAL, and FTS5 then ignores the rowid and
    // answers with its first match, so every hit would show the same excerpt.
    const excerpt = this.db.prepare(`SELECT snippet(message_search, 1, '', '', '…', 16) AS text
      FROM message_search WHERE message_search MATCH ? AND rowid = CAST(? AS INTEGER)`)
    return rows.map((row) => {
      const agentId = row.agent_id
      return {
        chatId: String(row.chat_id),
        eventId: String(row.event_id),
        ...(typeof agentId === 'string' ? { agentId } : {}),
        ts: Number(row.ts),
        snippet: String(excerpt.get(expressions.match, Number(row.seq))?.text ?? '').replace(/\s+/g, ' ').trim(),
        phrase: Number(row.phrase) === 1,
      }
    })
  }
  saveDocument(chatId: string, documentId: string, bytes: Uint8Array): void {
    this.db.prepare('INSERT OR REPLACE INTO documents(chat_id, document_id, bytes) VALUES (?, ?, ?)').run(chatId, documentId, bytes)
  }
  loadDocument(chatId: string, documentId: string): Uint8Array | undefined {
    const row = this.db.prepare('SELECT bytes FROM documents WHERE chat_id = ? AND document_id = ?').get(chatId, documentId)
    return row?.bytes instanceof Uint8Array ? row.bytes : undefined
  }
  documentIds(chatId: string): Set<string> {
    const rows = this.db.prepare('SELECT document_id FROM documents WHERE chat_id = ?').all(chatId)
    return new Set(rows.map((row) => String(row.document_id)))
  }
  delete(chatId: string): void {
    this.cache.delete(chatId)
    this.db.prepare('DELETE FROM events WHERE chat_id = ?').run(chatId)
    this.db.prepare('DELETE FROM documents WHERE chat_id = ?').run(chatId)
    this.metadata.delete(chatId)
    this.rewrites.delete(chatId)
    this.db.prepare("DELETE FROM records WHERE collection IN ('usageRuns', 'outboundSubmissions') AND json_extract(value, '$.chatId') = ?").run(chatId)
  }
}

/**
 * The FTS5 expressions for one typed query: `match` wants every word as a word prefix
 * anywhere in the message, `phrase` wants them adjacent and in order (null for a
 * single word, where the two are the same). Each word is quoted, so nothing typed can
 * be read as FTS syntax (`OR`, `NEAR`, a column filter).
 */
export function messageSearchExpressions(query: string): { match: string; phrase: string | null } | null {
  const words = searchWords(query)
  if (words.length === 0) return null
  return {
    match: words.map((word) => `"${word}"*`).join(' '),
    phrase: words.length === 1 ? null : `"${words.join(' ')}"*`,
  }
}

export class SqliteBundles {
  constructor(private db: DatabaseSync) {}
  get(skillId: string): SkillBundleFile[] {
    return this.db.prepare('SELECT path, bytes, sha256, mode FROM skill_files WHERE skill_id = ? ORDER BY path').all(skillId).map((row) => {
      if (!(row.bytes instanceof Uint8Array)) throw new Error('invalid stored skill bytes')
      return { path: String(row.path), bytes: row.bytes, sha256: String(row.sha256), mode: Number(row.mode) }
    })
  }
  set(skillId: string, files: readonly SkillBundleFile[]): void {
    this.delete(skillId)
    const insert = this.db.prepare('INSERT INTO skill_files(skill_id, path, bytes, sha256, mode) VALUES (?, ?, ?, ?, ?)')
    for (const file of files) insert.run(skillId, file.path, file.bytes, file.sha256, file.mode)
  }
  delete(skillId: string): void { this.db.prepare('DELETE FROM skill_files WHERE skill_id = ?').run(skillId) }
}
