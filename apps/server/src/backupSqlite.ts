import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DEFAULT_HOUSE_SETTINGS, HouseSettingsSchema, daysToMs } from '@manor/contracts'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

const RETAIN_MS = daysToMs(DEFAULT_HOUSE_SETTINGS.backupRetentionDays ?? 14)

export function defaultSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MANOR_SQLITE_PATH
    || path.join(env.MANOR_DATA_DIR || path.join(os.homedir(), '.manor'), 'sqlite', 'manor.db')
}

export function defaultBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MANOR_BACKUP_DIR
    || path.join(env.MANOR_DATA_DIR || path.join(os.homedir(), '.manor'), 'backups')
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function stamp(now: number): string {
  return new Date(now).toISOString().replaceAll(':', '').replace(/\.\d+Z$/, 'Z')
}

/**
 * The backup window saved in Settings, read from the database being copied, since the
 * nightly job runs outside the server. A database without the record, or one this
 * build cannot read, keeps the default fourteen days. Null keeps every copy.
 */
function savedRetentionMs(db: InstanceType<typeof DatabaseSync>): number | null {
  try {
    const row = db.prepare("SELECT value FROM records WHERE collection = 'settings' AND key = 'house'").get()
    const saved = HouseSettingsSchema.safeParse(row === undefined ? {} : JSON.parse(String(row.value)))
    if (!saved.success) return RETAIN_MS
    return saved.data.backupRetentionDays === null ? null : daysToMs(saved.data.backupRetentionDays)
  } catch {
    return RETAIN_MS
  }
}

/** Consistent live backup via VACUUM INTO. Drops copies older than the window set in Settings. */
export function backupSqlite(
  source: string,
  destDir: string,
  now = Date.now(),
): string {
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const dest = path.join(destDir, `manor-${stamp(now)}.db`)
  const db = new DatabaseSync(source, { readOnly: true })
  let retainMs: number | null
  try {
    db.exec(`VACUUM INTO ${sqlString(dest)}`)
    retainMs = savedRetentionMs(db)
  } finally {
    db.close()
  }
  chmodSync(dest, 0o600)
  if (retainMs !== null) pruneBackups(destDir, now, retainMs)
  return dest
}

/** Pre-migration copies kept beside the database; older ones go when a new one lands. */
const PRE_MIGRATION_KEEP = 2

/**
 * Copies the database before a schema upgrade touches it. Each migration runs in a
 * transaction, so a crash mid-migration already rolls back; this covers the other
 * case, a migration that commits and turns out to have reshaped data wrongly. The
 * nightly backup can be up to a day old by then, and that day is usually release day.
 */
export function snapshotBeforeMigration(
  db: InstanceType<typeof DatabaseSync>,
  filename: string,
  fromVersion: number,
  now = Date.now(),
): string {
  const dir = path.join(path.dirname(filename), 'pre-migration')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const dest = path.join(dir, `manor-v${fromVersion}-${stamp(now)}.db`)
  db.exec(`VACUUM INTO ${sqlString(dest)}`)
  chmodSync(dest, 0o600)
  const copies = readdirSync(dir)
    .filter((name) => name.startsWith('manor-v') && name.endsWith('.db'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const stale of copies.slice(PRE_MIGRATION_KEEP)) unlinkSync(stale)
  return dest
}

export function pruneBackups(destDir: string, now = Date.now(), retainMs = RETAIN_MS): void {
  for (const name of readdirSync(destDir)) {
    if (!name.startsWith('manor-') || !name.endsWith('.db')) continue
    const file = path.join(destDir, name)
    if (now - statSync(file).mtimeMs > retainMs) unlinkSync(file)
  }
}

// By name, not by comparing this module's location with the script that was started:
// folded into the server bundle, every module's location is the bundle's entry file,
// and the server would run a backup of a database that does not exist yet and stop.
const invoked = process.argv[1] !== undefined && /backupSqlite\.(?:ts|mjs|js)$/.test(process.argv[1])

// `pnpm backup:sqlite` loads apps/server/.env the way `start` does, so the nightly
// LaunchAgent backs up the database the server actually opens.
if (invoked) {
  const source = defaultSqlitePath()
  process.stdout.write(`source ${source}\n`)
  const dest = backupSqlite(source, defaultBackupDir())
  process.stdout.write(`${dest}\n`)
}
