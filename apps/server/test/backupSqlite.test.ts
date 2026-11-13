import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { backupSqlite, pruneBackups } from '../src/backupSqlite.js'
import { openSqlite, SQLITE_SCHEMA_VERSION } from '../src/stores/sqliteDatabase.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

describe('backupSqlite', () => {
  it('copies a live database with VACUUM INTO and drops old copies', () => {
    const root = path.join(os.tmpdir(), `manor-backup-${Date.now()}`)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const source = path.join(root, 'manor.db')
    const destDir = path.join(root, 'backups')
    const db = new DatabaseSync(source)
    db.exec('CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES (\'keep\');')
    db.close()
    chmodSync(source, 0o600)

    const dest = backupSqlite(source, destDir, Date.parse('2026-09-09T16:00:00Z'))
    expect(dest).toContain('manor-2026-09-09T160000Z.db')

    const copy = new DatabaseSync(dest, { readOnly: true })
    expect(copy.prepare('SELECT body FROM notes').get()).toEqual({ body: 'keep' })
    copy.close()

    const stale = path.join(destDir, 'manor-old.db')
    writeFileSync(stale, 'x')
    utimesSync(stale, new Date(0), new Date(0))
    pruneBackups(destDir, Date.parse('2026-09-09T16:00:00Z'))
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(dest)).toBe(true)
  })

  it('backs up the database named in the env file the package script loads', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-backup-env-'))
    const source = path.join(root, 'custom', 'live.db')
    const destDir = path.join(root, 'custom-backups')
    mkdirSync(path.dirname(source), { recursive: true })
    const db = new DatabaseSync(source)
    db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('nondefault');")
    db.close()
    writeFileSync(path.join(root, '.env'), `MANOR_SQLITE_PATH=${source}\nMANOR_BACKUP_DIR=${destDir}\n`)

    // The package script as launchd runs it, with the env file read from this disposable cwd.
    const serverDir = fileURLToPath(new URL('..', import.meta.url))
    const [bin, ...args] = (JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }).scripts['backup:sqlite']!.split(' ')
    // HOME points into the sandbox too, so a script that skipped the env file fails here
    // instead of falling back to the real ~/.manor database.
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MANOR_'))), HOME: root }
    const output = execFileSync(path.join(serverDir, 'node_modules/.bin', bin!),
      args.map((arg) => arg.startsWith('src/') ? path.join(serverDir, arg) : arg), { cwd: root, env, encoding: 'utf8' })

    expect(output).toContain(`source ${source}`)
    const [copy] = readdirSync(destDir)
    const backup = new DatabaseSync(path.join(destDir, copy!), { readOnly: true })
    expect(backup.prepare('SELECT body FROM notes').get()).toEqual({ body: 'nondefault' })
    backup.close()
  })
})

describe('backup retention from Settings', () => {
  it('prunes by the saved window and keeps every copy when it is set to keep all', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-backup-window-'))
    const source = path.join(root, 'manor.db')
    const destDir = path.join(root, 'backups')
    const store = openSqlite(source)
    const save = (days: number | null) => store.prepare(`INSERT INTO records(collection, key, value) VALUES('settings', 'house', ?)
      ON CONFLICT(collection, key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ backupRetentionDays: days }))
    mkdirSync(destDir, { recursive: true })
    const twentyDaysOld = path.join(destDir, 'manor-old.db')
    const now = Date.parse('2026-10-09T03:00:00Z')
    const age = (file: string, days: number) => utimesSync(file, new Date(now - days * 86_400_000), new Date(now - days * 86_400_000))

    save(null)
    writeFileSync(twentyDaysOld, 'x')
    age(twentyDaysOld, 20)
    backupSqlite(source, destDir, now)
    expect(existsSync(twentyDaysOld)).toBe(true)

    save(30)
    backupSqlite(source, destDir, now + 1000)
    expect(existsSync(twentyDaysOld)).toBe(true)

    save(7)
    backupSqlite(source, destDir, now + 2000)
    expect(existsSync(twentyDaysOld)).toBe(false)
    store.close()
  })
})

describe('pre-migration snapshot', () => {
  it('copies an existing database before migrating it, keeps the last two and skips a fresh one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-premigrate-'))
    const filename = path.join(root, 'manor.db')
    const snapshots = () => readdirSync(path.join(root, 'pre-migration')).sort()

    openSqlite(filename).close()
    expect(existsSync(path.join(root, 'pre-migration'))).toBe(false)

    for (const version of [8, 7, 6]) {
      const db = new DatabaseSync(filename)
      db.exec(`INSERT INTO records(collection, key, value) VALUES('notes', 'v${version}', '{}'); PRAGMA user_version = ${version};`)
      db.close()
      openSqlite(filename).close()
      // Distinct mtimes, so "the last two" is decided by age and not by name.
      for (const name of snapshots()) utimesSync(path.join(root, 'pre-migration', name), new Date(), new Date(Date.now() - 60_000))
    }

    const kept = snapshots()
    expect(kept).toHaveLength(2)
    const newest = kept.find((name) => name.startsWith('manor-v6-'))
    expect(newest).toBeDefined()
    const copy = new DatabaseSync(path.join(root, 'pre-migration', newest!), { readOnly: true })
    expect(copy.prepare('PRAGMA user_version').get()?.user_version).toBe(6)
    expect(copy.prepare("SELECT key FROM records WHERE collection = 'notes' ORDER BY key").all().map((row) => row.key)).toEqual(['v6', 'v7', 'v8'])
    copy.close()
  })

  it('refuses to start, and changes nothing, when the copy cannot be made', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-premigrate-fail-'))
    const filename = path.join(root, 'manor.db')
    openSqlite(filename).close()
    const db = new DatabaseSync(filename)
    db.exec('PRAGMA user_version = 8;')
    db.close()
    // A file where the snapshot folder should be makes the copy fail.
    writeFileSync(path.join(root, 'pre-migration'), 'not a folder')

    expect(() => openSqlite(filename)).toThrow('Could not copy the database before migrating it')
    const after = new DatabaseSync(filename, { readOnly: true })
    expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(8)
    after.close()
  })

  it('names the schema version of the newest migration file', () => {
    const files = readdirSync(fileURLToPath(new URL('../sqlite/migrations/', import.meta.url)))
    const newest = Math.max(...files.map((name) => Number.parseInt(name, 10)).filter(Number.isFinite))
    expect(SQLITE_SCHEMA_VERSION).toBe(newest)
  })
})
