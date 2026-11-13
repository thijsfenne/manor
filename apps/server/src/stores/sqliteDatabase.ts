import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'
import { splitUserMessage, type ThreadEvent } from '@manor/contracts'
import { foldUsageEvent, usageRunKey, type UsageRun } from '../usageReport.js'
import { snapshotBeforeMigration } from '../backupSqlite.js'
import { previewLine } from './previewLine.js'

// Vite 5's builtin list predates node:sqlite; Node owns loading this native module.
import { serverFile } from '../serverRoot.js'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

interface Migration {
  /** In `sqlite/migrations/`; the file ends by setting `user_version` to its own number. */
  file: string
  /** Runs in the migration's transaction before the file; throwing leaves the database untouched. */
  before?: (db: SqliteDatabase) => void
  /** Runs in the same transaction after the file, for rewrites SQL alone cannot express. */
  after?: (db: SqliteDatabase) => void
}

/** One entry per schema version, in order. A new migration is a new file and a new line here. */
const MIGRATIONS: readonly Migration[] = [
  { file: '001_initial.sql' },
  { file: '002_work_proposals.sql' },
  { file: '003_chat_mode.sql' },
  { file: '004_project_memory_scope.sql' },
  { file: '005_event_lookup.sql' },
  { file: '006_documents.sql' },
  { file: '007_persona_placement.sql', before: refusePlacedPersonasInGroups },
  { file: '008_provider_sessions.sql' },
  { file: '009_usage_runs.sql', after: refoldUsageRuns },
  { file: '010_message_search.sql' },
  { file: '011_wren_character.sql' },
  { file: '012_model_only_text.sql', after: (db) => { moveManorWording(db); repairManorPreviews(db) } },
  { file: '013_shared_chat_agents.sql' },
  { file: '014_home_room.sql' },
  { file: '015_relink_hidden_threads.sql' },
]

/** The `user_version` the last migration sets. */
export const SQLITE_SCHEMA_VERSION = MIGRATIONS.length

/**
 * Makes this process the one server on `filename` until it exits. A second server
 * would otherwise open the store and run its startup sweep, closing the first one's
 * live turns as hanging, before it fails on the taken port. The claim is an exclusive
 * transaction on the empty `<real path>.owner` file, so the OS drops it when the
 * process ends, even on SIGKILL. Keep the returned handle referenced; closing it
 * gives the claim up. Only the server claims: register scripts and backups still
 * open the database beside it.
 */
export function claimDatabaseOwner(filename: string): SqliteDatabase {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  // Named after the real file, so a symlinked or relative path to it meets the same
  // claim. The file is made first: a symlink's target that does not exist yet resolves
  // to the symlink, and the next start would claim under the target's name.
  closeSync(openSync(filename, 'a', 0o600))
  const owner = new DatabaseSync(`${realpathSync(filename)}.owner`)
  try {
    owner.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
  } catch (error) {
    owner.close()
    if ((error as { errcode?: unknown }).errcode === 5)
      throw new Error(`Another Manor server already uses ${filename}. Stop that one first; this start changed nothing.`)
    throw error
  }
  return owner
}

/** All private state stays beside the database, including WAL and shared-memory files. */
/**
 * `migrate: false` is for a helper that opens the database beside a running Manor,
 * such as a connector's register script. It refuses a database that still needs a
 * migration instead of applying one: the running app is on the older code, and a
 * database changed under it is one it can no longer read.
 */
export function openSqlite(filename: string, options: { migrate?: boolean } = {}): SqliteDatabase {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  if (filename !== ':memory:') chmodSync(filename, 0o600)
  const startVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version)
  if (startVersion > SQLITE_SCHEMA_VERSION) {
    db.close()
    throw new Error('This SQLite database requires a newer Manor version')
  }
  if (options.migrate === false && startVersion > 0 && startVersion < SQLITE_SCHEMA_VERSION) {
    db.close()
    throw new Error('This database is from an older Manor. Start Manor once so it can update the database, then run this again.')
  }
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA cache_size = -32768;')
  // A fresh database has nothing to lose; an existing one about to change gets a copy
  // first. Failing to copy stops the start, before any migration has touched the file.
  if (filename !== ':memory:' && startVersion > 0 && startVersion < SQLITE_SCHEMA_VERSION) {
    try {
      snapshotBeforeMigration(db, filename, startVersion)
    } catch (error) {
      db.close()
      throw new Error(`Could not copy the database before migrating it, so nothing was changed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const [index, migration] of MIGRATIONS.entries()) {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) > index) continue
    transaction(db, () => {
      migration.before?.(db)
      db.exec(readFileSync(serverFile('sqlite', 'migrations', migration.file), 'utf8'))
      migration.after?.(db)
    })
  }
  return db
}

/** Placement cannot be decided for a persona that still sits in a group or owns a routine. */
function refusePlacedPersonasInGroups(db: SqliteDatabase): void {
  const bound = db.prepare(`SELECT 1 FROM records
    WHERE (collection = 'chats' AND json_extract(value, '$.kind') = 'group'
      AND EXISTS (SELECT 1 FROM json_each(records.value, '$.memberIds') WHERE value IN ('wren', 'argus', 'ellis')))
    OR (collection = 'routines' AND json_extract(value, '$.agentId') IN ('wren', 'argus', 'ellis'))
    LIMIT 1`).get()
  if (bound !== undefined) throw new Error('Move Wren, Argus and Ellis out of groups and routines before migrating persona placement. No placement changes were saved.')
}

/**
 * Gives a user message stored before `instruction` existed the shape a new one has: the
 * wording only the model reads moves out of `text`, the model's input stays the same
 * string, and the search index follows through its update trigger. A message with an
 * `instruction` is skipped, so a second run changes nothing.
 */
function moveManorWording(db: SqliteDatabase): void {
  const rows = db.prepare(`SELECT seq, payload FROM events
    WHERE json_extract(payload, '$.type') = 'user_message' AND json_extract(payload, '$.text') LIKE '[Manor]%'
      AND json_extract(payload, '$.instruction') IS NULL`).all()
  const save = db.prepare('UPDATE events SET payload = ? WHERE seq = ?')
  for (const row of rows) {
    const event = JSON.parse(String(row.payload)) as Extract<ThreadEvent, { type: 'user_message' }>
    const { visible, instruction } = splitUserMessage(event)
    if (instruction !== '') save.run(JSON.stringify({ ...event, text: visible, instruction }), Number(row.seq))
  }
}

/**
 * A chat whose stored line is Manor's own wording for the model, such as a Single
 * Session that has not answered yet, gets the line its events would make now.
 */
function repairManorPreviews(db: SqliteDatabase): void {
  const rows = db.prepare(`SELECT key, value FROM records
    WHERE collection = 'transcriptMetadata' AND json_extract(value, '$.preview') LIKE '[Manor]%'`).all()
  const events = db.prepare('SELECT payload FROM events WHERE chat_id = ? ORDER BY seq')
  const save = db.prepare("UPDATE records SET value = ? WHERE collection = 'transcriptMetadata' AND key = ?")
  for (const row of rows) {
    const meta = JSON.parse(String(row.value)) as { preview: string | null }
    let preview: string | null = null
    for (const event of events.all(String(row.key))) {
      const line = previewLine(JSON.parse(String(event.payload)) as ThreadEvent)
      if (line !== undefined) preview = line
    }
    save.run(JSON.stringify({ ...meta, preview }), String(row.key))
  }
}

/** Rebuilds every derived usage run from the transcript, in event order per chat. */
function refoldUsageRuns(db: SqliteDatabase): void {
  const runs = new Map<string, UsageRun>()
  const rows = db.prepare(`SELECT chat_id, payload FROM events
    WHERE json_extract(payload, '$.type') IN ('turn_result', 'agent_message') ORDER BY chat_id, seq`).all()
  for (const row of rows) {
    const chatId = String(row.chat_id)
    const event = JSON.parse(String(row.payload)) as ThreadEvent
    if (event.type !== 'turn_result' && event.type !== 'agent_message') continue
    const key = usageRunKey(chatId, event.turnId, event.agentId)
    const run = foldUsageEvent(runs.get(key), chatId, event)
    if (run !== undefined) runs.set(key, run)
  }
  const insert = db.prepare('INSERT INTO records(collection, key, value) VALUES(?, ?, ?)')
  for (const [key, run] of runs) insert.run('usageRuns', key, JSON.stringify(run))
}

export function transaction<T>(db: SqliteDatabase, run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * One WAL snapshot for a read that spans several queries. A deferred read never
 * waits on another connection's write lock, and `query_only` turns a write that
 * slipped into a read path into an immediate error instead of a lock upgrade.
 */
export function readTransaction<T>(db: SqliteDatabase, run: () => T): T {
  db.exec('BEGIN DEFERRED')
  db.exec('PRAGMA query_only = ON')
  try {
    return run()
  } finally {
    db.exec('PRAGMA query_only = OFF')
    db.exec('COMMIT')
  }
}

/** Small domain records. Values are detached on read, so every mutation is an explicit write. */
export class SqliteRecords<T> {
  constructor(private db: SqliteDatabase, readonly collection: string) {}
  get(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE collection = ? AND key = ?').get(this.collection, key)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as T
  }
  has(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM records WHERE collection = ? AND key = ?').get(this.collection, key) !== undefined
  }
  set(key: string, value: T): this {
    this.db.prepare(`INSERT INTO records(collection, key, value) VALUES(?, ?, ?)
      ON CONFLICT(collection, key) DO UPDATE SET value = excluded.value`).run(this.collection, key, JSON.stringify(value))
    return this
  }
  delete(key: string): boolean {
    return this.db.prepare('DELETE FROM records WHERE collection = ? AND key = ?').run(this.collection, key).changes !== 0
  }
  clear(): void { this.db.prepare('DELETE FROM records WHERE collection = ?').run(this.collection) }
  get size(): number {
    return Number(this.db.prepare('SELECT count(*) AS count FROM records WHERE collection = ?').get(this.collection)?.count)
  }
  *entries(): IterableIterator<[string, T]> {
    for (const row of this.db.prepare('SELECT key, value FROM records WHERE collection = ? ORDER BY ordinal').all(this.collection)) {
      yield [String(row.key), JSON.parse(String(row.value)) as T]
    }
  }
  *keys(): IterableIterator<string> {
    for (const row of this.db.prepare('SELECT key FROM records WHERE collection = ? ORDER BY ordinal').all(this.collection)) yield String(row.key)
  }
  *values(): IterableIterator<T> { for (const [, value] of this.entries()) yield value }
  [Symbol.iterator](): IterableIterator<[string, T]> { return this.entries() }
}
