import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')

const MAX_USERNAME_LENGTH = 500
const MAX_PASSWORD_LENGTH = 4096
const INVALID_ORIGIN_MESSAGE = 'Only HTTP and HTTPS sites can save passwords.'

/** Seals passwords at rest; the app supplies one backed by the OS keychain (Electron safeStorage). */
export interface PasswordCipher {
  encrypt(plaintext: string): Buffer
  decrypt(encrypted: Buffer): string
}

/**
 * A login read from the browser the user copies from, used to refresh the copies Manor
 * stores under source 'dia'. The stored name dates from when Dia was the only such browser.
 */
export interface ImportedLogin {
  origin: string
  username: string
  password: string
  /** Unix milliseconds. */
  updatedAt: number
}

/** A stored login as shown to the UI; the password is only reachable through `credential()`. */
export interface SavedLogin {
  id: string
  origin: string
  username: string
  source: 'manor' | 'dia'
  updatedAt: number
}

export interface NeverSaveSite {
  origin: string
  source: 'manor' | 'dia'
}

export type SaveOffer = { kind: 'save' | 'update' } | null

/**
 * Reduces a page address or a Chromium signon_realm (e.g. "https://github.com/") to the
 * scheme://host[:port] origin logins are keyed by. Returns null for anything but http(s).
 */
export function loginOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

function requireOrigin(raw: string): string {
  const origin = typeof raw === 'string' ? loginOrigin(raw) : null
  if (!origin) throw new Error(INVALID_ORIGIN_MESSAGE)
  return origin
}

function requireUsername(raw: string): string {
  if (typeof raw !== 'string') throw new Error('The username must be a string.')
  const username = raw.trim()
  if (username.length > MAX_USERNAME_LENGTH) throw new Error(`The username is longer than ${MAX_USERNAME_LENGTH} characters.`)
  return username
}

function requirePassword(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('The password must not be empty.')
  if (raw.length > MAX_PASSWORD_LENGTH) throw new Error(`The password is longer than ${MAX_PASSWORD_LENGTH} characters.`)
  return raw
}

function toSavedLogin(row: Record<string, unknown>): SavedLogin {
  return {
    id: String(row.id),
    origin: String(row.origin),
    username: String(row.username),
    source: row.source === 'dia' ? 'dia' : 'manor',
    updatedAt: Number(row.updated_at),
  }
}

/** Saved site passwords, encrypted with the supplied cipher, plus the origins where saving was declined. */
export class BrowserPasswordStore {
  private readonly database: InstanceType<typeof DatabaseSync>

  constructor(filePath: string, private readonly cipher: PasswordCipher) {
    mkdirSync(path.dirname(filePath), { recursive: true })
    this.database = new DatabaseSync(filePath)
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS browser_logins (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        username TEXT NOT NULL,
        password BLOB NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('manor', 'dia')),
        updated_at INTEGER NOT NULL,
        UNIQUE (origin, username)
      );
      CREATE TABLE IF NOT EXISTS browser_never_save (
        origin TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('manor', 'dia'))
      );
    `)
  }

  /** What a just-submitted credential deserves: null when the identical one is stored or the origin is never-save. */
  offerFor(origin: string, username: string, password: string): SaveOffer {
    const site = requireOrigin(origin)
    const name = requireUsername(username)
    requirePassword(password)
    if (this.isNeverSave(site)) return null
    const row = this.database.prepare('SELECT password FROM browser_logins WHERE origin = ? AND username = ?').get(site, name)
    if (!row) return { kind: 'save' }
    try {
      if (this.cipher.decrypt(Buffer.from(row.password as Uint8Array)) === password) return null
    } catch {
      // A value that can no longer be decrypted is as good as a changed password.
    }
    return { kind: 'update' }
  }

  /** Upserts a login as source 'manor' and lifts any never-save mark on its origin. */
  save(origin: string, username: string, password: string): SavedLogin {
    const site = requireOrigin(origin)
    const name = requireUsername(username)
    requirePassword(password)
    const encrypted = this.cipher.encrypt(password)
    return this.transaction(() => {
      this.database.prepare('DELETE FROM browser_never_save WHERE origin = ?').run(site)
      const row = this.database.prepare(`
        INSERT INTO browser_logins (id, origin, username, password, source, updated_at)
        VALUES (?, ?, ?, ?, 'manor', ?)
        ON CONFLICT (origin, username) DO UPDATE SET
          password = excluded.password, source = 'manor', updated_at = excluded.updated_at
        RETURNING id, origin, username, source, updated_at
      `).get(randomUUID(), site, name, encrypted, Date.now())
      if (!row) throw new Error('The login could not be saved.')
      return toSavedLogin(row)
    })
  }

  neverSave(origin: string): void {
    this.database.prepare("INSERT OR REPLACE INTO browser_never_save (origin, source) VALUES (?, 'manor')")
      .run(requireOrigin(origin))
  }

  isNeverSave(origin: string): boolean {
    return this.database.prepare('SELECT 1 FROM browser_never_save WHERE origin = ?').get(requireOrigin(origin)) !== undefined
  }

  /** Logins for exactly this origin (scheme, host and port), newest first, without passwords. */
  forOrigin(origin: string): SavedLogin[] {
    return this.database.prepare(`
      SELECT id, origin, username, source, updated_at FROM browser_logins
      WHERE origin = ? ORDER BY updated_at DESC, username
    `).all(requireOrigin(origin)).map(toSavedLogin)
  }

  /** The decrypted credential, only for the moment it is filled into a page or revealed on request. */
  credential(id: string): { origin: string; username: string; password: string } | null {
    const row = this.database.prepare('SELECT origin, username, password FROM browser_logins WHERE id = ?').get(id)
    if (!row) return null
    return {
      origin: String(row.origin),
      username: String(row.username),
      password: this.cipher.decrypt(Buffer.from(row.password as Uint8Array)),
    }
  }

  /** Where offers are switched off, by the user in Manor or carried over from the imported browser. */
  neverSaveList(): NeverSaveSite[] {
    return this.database.prepare('SELECT origin, source FROM browser_never_save ORDER BY origin').all()
      .map((row) => ({ origin: String(row.origin), source: row.source === 'dia' ? 'dia' : 'manor' }))
  }

  /** Undoes Never for one site. With the browser copy on, an imported mark returns at the next launch. */
  allowSaving(origin: string): void {
    this.database.prepare('DELETE FROM browser_never_save WHERE origin = ?').run(requireOrigin(origin))
  }

  list(): SavedLogin[] {
    return this.database.prepare('SELECT id, origin, username, source, updated_at FROM browser_logins ORDER BY origin, username')
      .all().map(toSavedLogin)
  }

  remove(id: string): void {
    this.database.prepare('DELETE FROM browser_logins WHERE id = ?').run(id)
  }

  /** Forgets every login and never-save mark, imported copies included; with the browser copy on those return at the next launch. */
  removeAll(): void {
    this.transaction(() => {
      this.database.exec('DELETE FROM browser_logins; DELETE FROM browser_never_save;')
    })
  }

  /**
   * Mirrors the imported profile into Manor, newest wins: logins that vanished from the source are dropped, and a
   * Manor-saved login is only overwritten by an imported one that is more recent. Invalid entries are skipped.
   */
  replaceImported(logins: ImportedLogin[], neverSaveOrigins: string[]): void {
    const incoming = new Map<string, { origin: string; username: string; password: string; updatedAt: number }>()
    for (const login of logins) {
      try {
        const origin = requireOrigin(login.origin)
        const username = requireUsername(login.username)
        const password = requirePassword(login.password)
        const updatedAt = Number.isFinite(login.updatedAt) ? Math.trunc(login.updatedAt) : 0
        const key = JSON.stringify([origin, username])
        const previous = incoming.get(key)
        if (!previous || updatedAt >= previous.updatedAt) incoming.set(key, { origin, username, password, updatedAt })
      } catch {
        continue
      }
    }
    const blockedOrigins = new Set<string>()
    for (const raw of neverSaveOrigins) {
      const origin = typeof raw === 'string' ? loginOrigin(raw) : null
      if (origin) blockedOrigins.add(origin)
    }
    // Encrypt up front so a cipher failure cannot leave a half-applied transaction.
    const sealed = [...incoming].map(([key, login]) => ({ key, ...login, encrypted: this.cipher.encrypt(login.password) }))

    this.transaction(() => {
      for (const row of this.database.prepare("SELECT id, origin, username FROM browser_logins WHERE source = 'dia'").all()) {
        if (!incoming.has(JSON.stringify([String(row.origin), String(row.username)]))) {
          this.database.prepare('DELETE FROM browser_logins WHERE id = ?').run(String(row.id))
        }
      }
      const find = this.database.prepare('SELECT id, source, updated_at FROM browser_logins WHERE origin = ? AND username = ?')
      const insert = this.database.prepare(`
        INSERT INTO browser_logins (id, origin, username, password, source, updated_at) VALUES (?, ?, ?, ?, 'dia', ?)
      `)
      const overwrite = this.database.prepare("UPDATE browser_logins SET password = ?, source = 'dia', updated_at = ? WHERE id = ?")
      for (const login of sealed) {
        const existing = find.get(login.origin, login.username)
        if (!existing) insert.run(randomUUID(), login.origin, login.username, login.encrypted, login.updatedAt)
        else if (existing.source === 'dia' || login.updatedAt > Number(existing.updated_at)) {
          overwrite.run(login.encrypted, login.updatedAt, String(existing.id))
        }
      }

      this.database.exec("DELETE FROM browser_never_save WHERE source = 'dia'")
      const block = this.database.prepare("INSERT OR IGNORE INTO browser_never_save (origin, source) VALUES (?, 'dia')")
      for (const origin of blockedOrigins) block.run(origin)
    })
  }

  /** Drops everything that came from the imported browser and leaves what the user saved in Manor. */
  clearImported(): void {
    this.transaction(() => {
      this.database.exec("DELETE FROM browser_logins WHERE source = 'dia'; DELETE FROM browser_never_save WHERE source = 'dia';")
    })
  }

  close(): void { this.database.close() }

  private transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}
