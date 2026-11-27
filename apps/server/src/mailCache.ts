import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'
import {
  MAIL_INBOX_WINDOW,
  MAIL_REASON_MAX,
  MailLabelSchema,
  MailThreadSchema,
  type MailAddress,
  type MailCard,
  type MailLabel,
  type MailThread,
} from '@manor/contracts'
import { normalAddress, type MailEnvelope, type MailInbox, type MailThreadRef } from './mailSource.js'

// Vite 5's builtin list predates node:sqlite; Node owns loading this native module.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

/**
 * Bumped whenever a table below or the thread JSON in `bodies` changes. The cache is
 * disposable, so there are no migrations: a file on another version is emptied and the
 * next poll refills it. Version 2 only added each message's HTML part to the thread
 * JSON, so a version 1 file loses its bodies and keeps its labels, links and claims.
 */
export const MAIL_CACHE_SCHEMA_VERSION = 2

/**
 * Bumped when the triage rules move a kind of mail out of Other. A cache labelled under
 * older rules then loses the Other labels the agent gave, so that mail is sorted again
 * by the next run. Version 2 took receipts, confirmations and portal notices out of Other.
 */
export const MAIL_TRIAGE_RULES_VERSION = 2

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE messages (
  uid INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  message_id TEXT,
  subject TEXT NOT NULL,
  from_json TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  at INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE INDEX messages_thread ON messages (thread_id);
CREATE TABLE bodies (thread_id TEXT PRIMARY KEY, uids TEXT NOT NULL, thread_json TEXT NOT NULL);
CREATE TABLE labels (thread_id TEXT PRIMARY KEY, label TEXT NOT NULL, reason TEXT, set_by TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE links (address TEXT PRIMARY KEY, project_id TEXT NOT NULL);
CREATE TABLE opened (thread_id TEXT PRIMARY KEY, through_uid INTEGER NOT NULL);
CREATE TABLE archives (thread_id TEXT PRIMARY KEY, receipt TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE send_claims (
  request_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX send_claims_thread ON send_claims (thread_id, at);
`

/** Who gave a label: the triage run's agent, or the user. A user's label is never overwritten by the agent. */
export type MailLabelSetter = 'agent' | 'user'

/** One send attempt as slice B's send path records it: `started` before the port call, the outcome after. */
export type MailSendClaimStatus = 'started' | 'sent' | 'refused' | 'uncertain'

export interface MailSendClaim {
  requestId: string
  threadId: string
  status: MailSendClaimStatus
  message?: string
  at: number
}

export interface MailCacheMeta {
  uidValidity?: string
  account?: string
  syncedAt: number | null
  triageLastRunAt: number | null
  triageError?: string
}

/** A thread still in the cached Inbox: what the source needs, plus what its card shows. */
export interface MailInboxThread extends MailThreadRef {
  subject: string
}

interface MessageRow {
  uid: number
  thread_id: string
  gmail_thread_id: string | null
  message_id: string | null
  subject: string
  from_json: string
  to_json: string
  cc_json: string
  at: number
  seen: number
}

const rowOf = (message: MailEnvelope) => ({
  uid: message.uid,
  thread_id: message.threadId,
  gmail_thread_id: message.gmailThreadId ?? null,
  message_id: message.messageId ?? null,
  subject: message.subject,
  from_json: JSON.stringify(message.from),
  to_json: JSON.stringify(message.to),
  cc_json: JSON.stringify(message.cc),
  at: message.at,
  seen: message.seen ? 1 : 0,
})

const envelopeOf = (row: MessageRow): MailEnvelope => ({
  uid: row.uid,
  threadId: row.thread_id,
  ...(row.gmail_thread_id === null ? {} : { gmailThreadId: row.gmail_thread_id }),
  ...(row.message_id === null ? {} : { messageId: row.message_id }),
  subject: row.subject,
  from: JSON.parse(row.from_json) as MailAddress,
  to: JSON.parse(row.to_json) as MailAddress[],
  cc: JSON.parse(row.cc_json) as MailAddress[],
  at: row.at,
  seen: row.seen === 1,
})

const uidKey = (uids: readonly number[]) => [...uids].sort((left, right) => left - right).join(',')

function transaction<T>(db: SqliteDatabase, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Opens `file` on the current schema, emptying it when it is on another one. Throws on a file that is not SQLite. */
function openOnSchema(file: string): SqliteDatabase {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    if (file !== ':memory:') chmodSync(file, 0o600)
    // The default rollback journal, not WAL: a WAL file left beside a deleted cache
    // would be replayed into the fresh one.
    db.exec('PRAGMA busy_timeout = 5000')
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    if (version === 1) {
      transaction(db, () => {
        db.exec('DELETE FROM bodies')
        db.exec(`PRAGMA user_version = ${MAIL_CACHE_SCHEMA_VERSION}`)
      })
    } else if (version !== MAIL_CACHE_SCHEMA_VERSION) {
      transaction(db, () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
        for (const table of tables) db.exec(`DROP TABLE IF EXISTS "${String(table.name).replace(/"/g, '""')}"`)
        db.exec(SCHEMA)
        db.exec(`PRAGMA user_version = ${MAIL_CACHE_SCHEMA_VERSION}`)
      })
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * The Mail door's own SQLite file: the recent Inbox window's headers, the bodies of
 * opened threads, and what only Manor knows (labels, sender links, local opened marks,
 * archive receipts for Undo, send claims). The IMAP server stays the truth, so the
 * file may be deleted at any time: a missing, unreadable or outdated file opens empty
 * and the next poll refills it. Labels and links are the only thing such a reset loses.
 */
export class MailCache {
  private constructor(private readonly db: SqliteDatabase) {}

  /**
   * Never throws for a bad file: whatever is at `file` that cannot be read is replaced.
   * A cache written for another mailbox is emptied, labels and links included, so one
   * account's mail never shows under another. `fresh` replaces the file outright. A cache
   * labelled under older triage rules keeps every label but the agent's Other ones.
   */
  static open(file: string, account: string, options: { fresh?: boolean } = {}): MailCache {
    const remove = () => {
      for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
    }
    if (options.fresh === true && file !== ':memory:') remove()
    let cache: MailCache
    try {
      cache = new MailCache(openOnSchema(file))
    } catch {
      remove()
      cache = new MailCache(openOnSchema(file))
    }
    const owner = cache.getMeta('account')
    if (owner !== undefined && owner !== account) cache.empty()
    cache.setMeta('account', account)
    // One step, so of two servers opening the file at once only the first clears anything.
    transaction(cache.db, () => {
      // Labels written under newer rules than this build knows are left alone.
      if (Number(cache.getMeta('triageRules') ?? 0) >= MAIL_TRIAGE_RULES_VERSION) return
      cache.db.exec("DELETE FROM labels WHERE set_by = 'agent' AND label = 'other'")
      cache.setMeta('triageRules', String(MAIL_TRIAGE_RULES_VERSION))
    })
    return cache
  }

  /** Every row of every table, gone; the file stays. */
  private empty(): void {
    transaction(this.db, () => {
      for (const table of ['meta', 'messages', 'bodies', 'labels', 'links', 'opened', 'archives', 'send_claims']) this.db.exec(`DELETE FROM ${table}`)
    })
  }

  close(): void {
    this.db.close()
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row === undefined ? undefined : String(row.value)
  }

  /** `undefined` removes the key. Slice B keeps its triage claim here too. */
  setMeta(key: string, value: string | undefined): void {
    if (value === undefined) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  meta(): MailCacheMeta {
    const number = (key: string) => {
      const value = this.getMeta(key)
      return value === undefined ? null : Number(value)
    }
    const uidValidity = this.getMeta('uidValidity')
    const account = this.getMeta('account')
    const triageError = this.getMeta('triageError')
    return {
      ...(uidValidity === undefined ? {} : { uidValidity }),
      ...(account === undefined ? {} : { account }),
      syncedAt: number('syncedAt'),
      triageLastRunAt: number('triageLastRunAt'),
      ...(triageError === undefined ? {} : { triageError }),
    }
  }

  /** A finished triage run: when, and why it failed when it did. A good run clears the old error. */
  recordTriageRun(at: number, error?: string): void {
    this.setMeta('triageLastRunAt', String(at))
    this.setMeta('triageError', error?.slice(0, 400))
  }

  /**
   * Makes the cached Inbox match one fresh listing: new messages in, gone ones out, seen
   * flags updated. A new UIDVALIDITY drops every uid-keyed row first. Threads in `skip`
   * are being archived right now and stay out even when this listing still has them.
   * Mail that arrives in a labelled thread after the label was set drops the label, so
   * an answer to a Waiting thread comes up for triage again.
   */
  reconcile(inbox: MailInbox, at: number, skip: ReadonlySet<string> = new Set()): void {
    transaction(this.db, () => {
      // Uids only grow within one numbering, so anything above the highest known one is new.
      let knownUid: number | undefined
      if (this.getMeta('uidValidity') !== inbox.uidValidity) {
        this.db.exec('DELETE FROM messages; DELETE FROM bodies; DELETE FROM opened;')
      } else {
        knownUid = Number(this.db.prepare('SELECT MAX(uid) AS uid FROM messages').get()?.uid ?? 0)
      }
      // A thread put back by Undo also gets a new uid, but the server took its mail in before
      // the label was set. The server's own time decides; a sender's date can be anything.
      const outdated = this.db.prepare('DELETE FROM labels WHERE thread_id = ? AND at < ?')
      const listed = inbox.messages.filter((message) => !skip.has(message.threadId)).slice(-MAIL_INBOX_WINDOW)
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS listed (uid INTEGER PRIMARY KEY); DELETE FROM listed;')
      const remember = this.db.prepare('INSERT OR IGNORE INTO listed (uid) VALUES (?)')
      const upsert = this.db.prepare(`INSERT INTO messages (uid, thread_id, gmail_thread_id, message_id, subject, from_json, to_json, cc_json, at, seen)
        VALUES (:uid, :thread_id, :gmail_thread_id, :message_id, :subject, :from_json, :to_json, :cc_json, :at, :seen)
        ON CONFLICT (uid) DO UPDATE SET thread_id = excluded.thread_id, gmail_thread_id = excluded.gmail_thread_id,
          message_id = excluded.message_id, subject = excluded.subject, from_json = excluded.from_json,
          to_json = excluded.to_json, cc_json = excluded.cc_json, at = excluded.at, seen = excluded.seen`)
      for (const message of listed) {
        if (knownUid !== undefined && message.uid > knownUid) outdated.run(message.threadId, message.receivedAt ?? message.at)
        remember.run(message.uid)
        upsert.run(rowOf(message))
      }
      this.db.exec(`DELETE FROM messages WHERE uid NOT IN (SELECT uid FROM listed);
        DELETE FROM bodies WHERE thread_id NOT IN (SELECT thread_id FROM messages);
        DELETE FROM opened WHERE thread_id NOT IN (SELECT thread_id FROM messages);
        DELETE FROM listed;`)
      this.setMeta('uidValidity', inbox.uidValidity)
      this.setMeta('syncedAt', String(at))
    })
  }

  private rows(threadId?: string): MessageRow[] {
    const rows = threadId === undefined
      ? this.db.prepare('SELECT * FROM messages ORDER BY at, uid').all()
      : this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY at, uid').all(threadId)
    return rows as unknown as MessageRow[]
  }

  /**
   * The sidebar, newest first. The newest Inbox message stands for a thread; the subject
   * is its oldest Inbox message's, so a thread does not turn into `Re:` when answered.
   * A link to a project not in `projectIds` is dropped here, for good.
   */
  cards(projectIds: ReadonlySet<string>): MailCard[] {
    const links = this.links()
    for (const [address, projectId] of links) {
      if (!projectIds.has(projectId)) {
        this.db.prepare('DELETE FROM links WHERE address = ?').run(address)
        links.delete(address)
      }
    }
    const labels = new Map(
      this.db.prepare('SELECT thread_id, label, reason FROM labels').all().map((row) => [String(row.thread_id), row] as const),
    )
    const opened = new Map(
      this.db.prepare('SELECT thread_id, through_uid FROM opened').all().map((row) => [String(row.thread_id), Number(row.through_uid)] as const),
    )
    const threads = new Map<string, MailEnvelope[]>()
    for (const row of this.rows()) {
      const message = envelopeOf(row)
      threads.set(message.threadId, [...(threads.get(message.threadId) ?? []), message])
    }
    const cards: MailCard[] = []
    for (const [threadId, messages] of threads) {
      const newest = messages.at(-1)!
      const throughUid = opened.get(threadId) ?? 0
      const labelRow = labels.get(threadId)
      const label = MailLabelSchema.safeParse(labelRow?.label)
      const projectId = links.get(normalAddress(newest.from.address))
      cards.push({
        threadId,
        subject: messages[0]!.subject.slice(0, 1_000),
        from: newest.from,
        at: newest.at,
        unread: messages.some((message) => !message.seen && message.uid > throughUid),
        messageCount: messages.length,
        ...(label.success ? { label: label.data } : {}),
        ...(label.success && typeof labelRow?.reason === 'string' ? { reason: labelRow.reason } : {}),
        ...(projectId === undefined ? {} : { projectId }),
      })
    }
    return cards.sort((left, right) => right.at - left.at).slice(0, MAIL_INBOX_WINDOW)
  }

  /** The thread's Inbox messages as the source needs them, or undefined when it left the Inbox. */
  inboxThread(threadId: string): MailInboxThread | undefined {
    const messages = this.rows(threadId).map(envelopeOf)
    const uidValidity = this.getMeta('uidValidity')
    if (messages.length === 0 || uidValidity === undefined) return undefined
    const gmailThreadId = messages.find((message) => message.gmailThreadId !== undefined)?.gmailThreadId
    return {
      threadId,
      ...(gmailThreadId === undefined ? {} : { gmailThreadId }),
      uidValidity,
      uids: messages.map((message) => message.uid).sort((left, right) => left - right),
      subject: messages[0]!.subject,
    }
  }

  /** The cached thread, only while its Inbox messages are still the ones it was read with. */
  cachedThread(threadId: string): MailThread | undefined {
    const inbox = this.inboxThread(threadId)
    if (inbox === undefined) return undefined
    const row = this.db.prepare('SELECT uids, thread_json FROM bodies WHERE thread_id = ?').get(threadId)
    if (row === undefined || String(row.uids) !== uidKey(inbox.uids)) return undefined
    const parsed = MailThreadSchema.safeParse(JSON.parse(String(row.thread_json)))
    return parsed.success ? parsed.data : undefined
  }

  storeThread(thread: MailThread, uids: readonly number[]): void {
    this.db.prepare('INSERT INTO bodies (thread_id, uids, thread_json) VALUES (?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET uids = excluded.uids, thread_json = excluded.thread_json')
      .run(thread.threadId, uidKey(uids), JSON.stringify(thread))
  }

  /**
   * Opened here, through the newest Inbox uid the reader was shown: the card reads as
   * read until a newer message arrives. The server's flag is untouched.
   */
  markOpened(threadId: string, throughUid: number): void {
    this.db.prepare(`INSERT INTO opened (thread_id, through_uid) VALUES (?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET through_uid = MAX(through_uid, excluded.through_uid)`).run(threadId, throughUid)
  }

  /**
   * Sets a label. The agent's comes with a one-line reason and never replaces a label
   * the user set; the user's replaces anything and carries no reason. False when the
   * agent's label was refused for that reason.
   */
  setLabel(threadId: string, label: MailLabel, by: MailLabelSetter, reason?: string, at = Date.now()): boolean {
    if (by === 'agent') {
      const current = this.db.prepare('SELECT set_by FROM labels WHERE thread_id = ?').get(threadId)
      if (current?.set_by === 'user') return false
    }
    const line = by === 'agent' ? reason?.replace(/\s+/g, ' ').trim().slice(0, MAIL_REASON_MAX) || null : null
    this.db.prepare(`INSERT INTO labels (thread_id, label, reason, set_by, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET label = excluded.label, reason = excluded.reason, set_by = excluded.set_by, at = excluded.at`)
      .run(threadId, label, line, by, at)
    return true
  }

  label(threadId: string): { label: MailLabel; reason?: string; by: MailLabelSetter } | undefined {
    const row = this.db.prepare('SELECT label, reason, set_by FROM labels WHERE thread_id = ?').get(threadId)
    const label = MailLabelSchema.safeParse(row?.label)
    if (row === undefined || !label.success) return undefined
    return { label: label.data, ...(typeof row.reason === 'string' ? { reason: row.reason } : {}), by: row.set_by === 'agent' ? 'agent' : 'user' }
  }

  /** Sender address (lowercased) to project id. */
  links(): Map<string, string> {
    return new Map(this.db.prepare('SELECT address, project_id FROM links').all().map((row) => [String(row.address), String(row.project_id)] as const))
  }

  linkSender(address: string, projectId: string | null): void {
    if (projectId === null) this.db.prepare('DELETE FROM links WHERE address = ?').run(normalAddress(address))
    else this.db.prepare('INSERT INTO links (address, project_id) VALUES (?, ?) ON CONFLICT (address) DO UPDATE SET project_id = excluded.project_id').run(normalAddress(address), projectId)
  }

  /** Removes the thread's Inbox rows and hands them back, so a failed archive can put them back. */
  takeThread(threadId: string): MailEnvelope[] {
    return transaction(this.db, () => {
      const rows = this.rows(threadId).map(envelopeOf)
      this.db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
      return rows
    })
  }

  putBack(messages: readonly MailEnvelope[]): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO messages (uid, thread_id, gmail_thread_id, message_id, subject, from_json, to_json, cc_json, at, seen)
      VALUES (:uid, :thread_id, :gmail_thread_id, :message_id, :subject, :from_json, :to_json, :cc_json, :at, :seen)`)
    transaction(this.db, () => {
      for (const message of messages) insert.run(rowOf(message))
    })
  }

  saveArchive(threadId: string, receipt: string, at = Date.now()): void {
    this.db.prepare('INSERT INTO archives (thread_id, receipt, at) VALUES (?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET receipt = excluded.receipt, at = excluded.at')
      .run(threadId, receipt, at)
  }

  archiveReceipt(threadId: string): string | undefined {
    const row = this.db.prepare('SELECT receipt FROM archives WHERE thread_id = ?').get(threadId)
    return row === undefined ? undefined : String(row.receipt)
  }

  dropArchive(threadId: string): void {
    this.db.prepare('DELETE FROM archives WHERE thread_id = ?').run(threadId)
  }

  /** Writes one send attempt, or moves it to its outcome under the same request id. */
  recordSendClaim(claim: MailSendClaim): void {
    this.db.prepare(`INSERT INTO send_claims (request_id, thread_id, status, message, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (request_id) DO UPDATE SET status = excluded.status, message = excluded.message, at = excluded.at`)
      .run(claim.requestId, claim.threadId, claim.status, claim.message?.slice(0, 600) ?? null, claim.at)
  }

  /** The thread's send attempts, newest first. */
  sendClaims(threadId: string): MailSendClaim[] {
    return this.db.prepare('SELECT * FROM send_claims WHERE thread_id = ? ORDER BY at DESC').all(threadId).map((row) => ({
      requestId: String(row.request_id),
      threadId: String(row.thread_id),
      status: String(row.status) as MailSendClaimStatus,
      ...(typeof row.message === 'string' ? { message: row.message } : {}),
      at: Number(row.at),
    }))
  }

  /** At startup: a send still `started` was cut off by a crash, so whether it left is unknown. */
  markStartedSendClaimsUncertain(): number {
    return Number(this.db.prepare("UPDATE send_claims SET status = 'uncertain' WHERE status = 'started'").run().changes)
  }
}
