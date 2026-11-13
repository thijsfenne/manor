import { createDecipheriv, createHash, pbkdf2Sync, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { rmSync, statSync, type Dirent } from 'node:fs'
import { createRequire } from 'node:module'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CookiesSetDetails } from 'electron'
import type { BrowserImportStatus, ImportBrowserId } from '@manor/contracts'
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')

const execFileAsync = promisify(execFile)

/**
 * The Chromium browsers Manor can copy logins from. They share one profile format;
 * what differs is where the profile lives under `~/Library/Application Support` and
 * the name of the Keychain item that holds the key for its cookies and passwords
 * (service `<keychain> Safe Storage`, account `<keychain>`). Safari keeps another
 * format and is not here. The order is the order a picker offers them in.
 */
export const IMPORT_BROWSERS: Readonly<Record<ImportBrowserId, { name: string; userData: readonly string[]; keychain: string }>> = {
  chrome: { name: 'Chrome', userData: ['Google', 'Chrome'], keychain: 'Chrome' },
  arc: { name: 'Arc', userData: ['Arc', 'User Data'], keychain: 'Arc' },
  brave: { name: 'Brave', userData: ['BraveSoftware', 'Brave-Browser'], keychain: 'Brave' },
  edge: { name: 'Edge', userData: ['Microsoft Edge'], keychain: 'Microsoft Edge' },
  dia: { name: 'Dia', userData: ['Dia', 'User Data'], keychain: 'Dia' },
}

/**
 * Spelled from the table, not imported: the desktop runtime cannot load values from
 * the contracts package (`runtimeImportsSmoke.ts`), only its types.
 */
export const IMPORT_BROWSER_IDS = Object.keys(IMPORT_BROWSERS) as ImportBrowserId[]

// Both names predate the other browsers and stay, so an install that already
// copies from Dia keeps its consent and its generation.
const SETTINGS_FILE = 'dia-profile-snapshot.json'
const SNAPSHOT_DIRECTORY = 'Dia Profile Snapshots'

const IGNORED_NAMES = new Set([
  'Cache',
  'Code Cache',
  'DawnCache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  // Service worker caches. Large in a daily-driver profile and rebuilt on demand.
  'CacheStorage',
  'ScriptCache',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
])

const COOKIE_FILES = ['Cookies', path.join('Network', 'Cookies')]
const LOGIN_FILES = ['Login Data', 'Login Data For Account']
const SQLITE_SIDECARS = ['', '-journal', '-wal', '-shm']

interface BrowserProfileSnapshotOptions {
  homeDirectory?: string
  manorDataDirectory: string
  platform?: NodeJS.Platform
  readSafeStoragePassword?: (browser: ImportBrowserId) => Promise<string>
}

interface SnapshotSettings {
  enabled: boolean
  /** Absent in a file written before there was a choice, which meant Dia. */
  browser?: ImportBrowserId
}

interface LocalState {
  profile?: {
    last_used?: unknown
  }
}

/** A saved password from the source browser, decrypted in memory only and handed to Manor's password store. */
export interface ImportedLogin {
  origin: string
  username: string
  password: string
  /** Unix milliseconds of the last password change in the source browser. */
  updatedAt: number
}

export interface PreparedBrowserProfile {
  path: string
  /** A new generation; false when the source's cookies were merged into the kept one. */
  fresh: boolean
  cookies: CookiesSetDetails[]
  logins: ImportedLogin[]
  neverSaveOrigins: string[]
  warning?: string
}

/**
 * Owns the one-way boundary between the user's own browser and Manor. The source is
 * only ever read. Enabling copies the browser's active profile into a Manor-owned
 * generation; later launches keep that generation, so logins made inside Manor
 * survive, and merge in only the source cookies that are newer than Manor's.
 * Credentials leave the copy decrypted in memory: cookies go through Electron's
 * cookie API, passwords to Manor's store. One browser at a time: picking another
 * replaces the copy.
 */
export class BrowserProfileSnapshot {
  private readonly homeDirectory: string
  private readonly platform: NodeJS.Platform
  private readonly readPassword: (browser: ImportBrowserId) => Promise<string>
  private lastError: string | undefined
  private lastWarning: string | undefined

  constructor(private readonly options: BrowserProfileSnapshotOptions) {
    this.homeDirectory = options.homeDirectory ?? os.homedir()
    this.platform = options.platform ?? process.platform
    this.readPassword = options.readSafeStoragePassword ?? ((browser) => readSafeStoragePassword(this.homeDirectory, browser))
  }

  get snapshotsPath(): string {
    return path.join(this.options.manorDataDirectory, SNAPSHOT_DIRECTORY)
  }

  async status(): Promise<BrowserImportStatus> {
    const settings = await this.readSettings()
    const browsers = await Promise.all(IMPORT_BROWSER_IDS.map(async (id) => ({
      id,
      name: IMPORT_BROWSERS[id].name,
      installed: this.platform === 'darwin' && await isFile(path.join(this.userData(id), 'Local State')),
    })))
    // Off and never chosen: offer the first browser that is actually on this Mac.
    const browser = settings.browser ?? (settings.enabled ? 'dia' : browsers.find((entry) => entry.installed)?.id ?? 'chrome')
    const shared = { enabled: settings.enabled, browser, browsers }
    try {
      const profile = await this.resolveActiveProfile(browser)
      return {
        ...shared,
        available: true,
        profileName: profile.name,
        ...(this.lastError === undefined ? {} : { error: this.lastError }),
        ...(this.lastWarning === undefined ? {} : { warning: this.lastWarning }),
      }
    } catch (error: unknown) {
      return { ...shared, available: false, error: messageOf(error) }
    }
  }

  async isEnabled(): Promise<boolean> {
    return (await this.readSettings()).enabled
  }

  /** The browser the copy comes from. A consent given before there was a choice meant Dia. */
  private async source(): Promise<ImportBrowserId> {
    return (await this.readSettings()).browser ?? 'dia'
  }

  private async readSettings(): Promise<SnapshotSettings> {
    try {
      const raw = JSON.parse(await readFile(this.settingsPath(), 'utf8')) as Partial<SnapshotSettings>
      const browser = IMPORT_BROWSER_IDS.find((id) => id === raw.browser)
      return { enabled: raw.enabled === true, ...(browser === undefined ? {} : { browser }) }
    } catch {
      return { enabled: false }
    }
  }

  /**
   * Runs once per app session before the browser Session opens. Keeps the current
   * generation and merges the source's newer cookies into it; copies afresh only when no
   * generation survives.
   */
  async prepareEnabledSnapshot(): Promise<PreparedBrowserProfile | null> {
    if (!(await this.isEnabled())) {
      // Recovers the crash window between promoting a first snapshot and persisting
      // consent. Off must converge to no copied credentials on the next launch.
      await rm(this.snapshotsPath, { recursive: true, force: true })
      return null
    }
    try {
      const browser = await this.source()
      const current = await this.currentGeneration()
      const prepared = current === null ? await this.refresh(browser) : await this.merge(current, browser)
      this.lastError = undefined
      this.lastWarning = prepared.warning
      return prepared
    } catch (error: unknown) {
      this.lastError = messageOf(error)
      this.lastWarning = undefined
      throw error
    }
  }

  /**
   * Consent is persisted only after the complete snapshot is ready to use. Naming
   * another browser than the one in use replaces the copy; a failed switch keeps the
   * old one.
   */
  async enable(browser?: ImportBrowserId): Promise<PreparedBrowserProfile> {
    const wasEnabled = await this.isEnabled()
    const chosen = browser ?? await this.source()
    try {
      const prepared = await this.refresh(chosen)
      await this.writeSettings({ enabled: true, browser: chosen })
      this.lastError = undefined
      this.lastWarning = prepared.warning
      return prepared
    } catch (error: unknown) {
      if (!wasEnabled) {
        await rm(this.snapshotsPath, { recursive: true, force: true })
        await this.writeSettings({ enabled: false }).catch(() => undefined)
      }
      this.lastError = messageOf(error)
      this.lastWarning = undefined
      throw error
    }
  }

  /** Revocation succeeds only when the copied credentials are gone. */
  async disable(): Promise<void> {
    const { browser } = await this.readSettings()
    await rm(this.snapshotsPath, { recursive: true, force: true })
    // The choice is kept, so switching back on offers the same browser.
    await this.writeSettings({ enabled: false, ...(browser === undefined ? {} : { browser }) })
    this.lastError = undefined
    this.lastWarning = undefined
  }

  private async refresh(browser: ImportBrowserId): Promise<PreparedBrowserProfile> {
    const name = IMPORT_BROWSERS[browser].name
    const source = await this.resolveActiveProfile(browser)
    const generation = randomUUID()
    const staging = path.join(this.snapshotsPath, `.staging-${generation}`)
    const destination = path.join(this.snapshotsPath, generation)

    await mkdir(this.snapshotsPath, { recursive: true, mode: 0o700 })
    try {
      await copyDirectory(source.path, staging)
      const password = await this.readSafeStoragePassword(browser)
      const cookiePath = firstExisting(COOKIE_FILES.map((file) => path.join(staging, file)))
      if (cookiePath === null) throw new Error(`${name}'s active profile has no Chromium Cookies database.`)
      const cookies = readCookies(cookiePath, password, name)
      const logins = readLogins(staging, password, name)
      removeDatabases(staging, [...COOKIE_FILES, ...LOGIN_FILES])
      await rename(staging, destination)
      await this.pruneExcept(generation)
      return prepared(destination, true, cookies, logins, name)
    } catch (error: unknown) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  /**
   * Brings the source's newer logins into the kept generation without touching what
   * Manor itself stored there. Only cookies, saved passwords and History are read from
   * the source; Local Storage and IndexedDB stay Manor's after the first copy, because
   * Chromium's LevelDB stores cannot be merged.
   */
  private async merge(generation: string, browser: ImportBrowserId): Promise<PreparedBrowserProfile> {
    const name = IMPORT_BROWSERS[browser].name
    const source = await this.resolveActiveProfile(browser)
    const scratch = path.join(this.snapshotsPath, `.merge-${randomUUID()}`)
    await mkdir(scratch, { recursive: true, mode: 0o700 })
    try {
      await copyDatabases(source.path, scratch, [...COOKIE_FILES, ...LOGIN_FILES, 'History'])
      const password = await this.readSafeStoragePassword(browser)
      const cookiePath = firstExisting(COOKIE_FILES.map((file) => path.join(scratch, file)))
      if (cookiePath === null) throw new Error(`${name}'s active profile has no Chromium Cookies database.`)
      const manorCookies = firstExisting(COOKIE_FILES.map((file) => path.join(generation, file)))
      const cookies = readCookies(cookiePath, password, name, manorCookies === null ? new Map() : cookieFreshness(manorCookies))
      const logins = readLogins(scratch, password, name)
      // Electron keeps no History of its own; this file only feeds Manor's history index.
      removeDatabases(generation, ['History', ...LOGIN_FILES])
      await copyDatabases(scratch, generation, ['History'])
      await this.pruneExcept(path.basename(generation))
      return prepared(generation, false, cookies, logins, name)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  private async readSafeStoragePassword(browser: ImportBrowserId): Promise<string> {
    const password = await this.readPassword(browser)
    if (password === '') throw new Error(`${IMPORT_BROWSERS[browser].keychain} Safe Storage returned an empty password.`)
    return password
  }

  private userData(browser: ImportBrowserId): string {
    return path.join(this.homeDirectory, 'Library', 'Application Support', ...IMPORT_BROWSERS[browser].userData)
  }

  /** The newest complete generation; staging and merge scratch folders start with a dot. */
  private async currentGeneration(): Promise<string | null> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.snapshotsPath, { withFileTypes: true })
    } catch {
      return null
    }
    let newest: { path: string; time: number } | null = null
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const candidate = path.join(this.snapshotsPath, entry.name)
      const time = (await stat(candidate)).mtimeMs
      if (newest === null || time > newest.time) newest = { path: candidate, time }
    }
    return newest?.path ?? null
  }

  private async pruneExcept(generation: string): Promise<void> {
    for (const entry of await readdir(this.snapshotsPath)) {
      if (entry !== generation) {
        await rm(path.join(this.snapshotsPath, entry), { recursive: true, force: true })
      }
    }
  }

  private async resolveActiveProfile(browser: ImportBrowserId): Promise<{ name: string; path: string }> {
    const label = IMPORT_BROWSERS[browser].name
    if (this.platform !== 'darwin') {
      throw new Error('Browser login copies are only available in the Manor desktop app on macOS.')
    }
    const userData = this.userData(browser)
    const localStatePath = path.join(userData, 'Local State')
    let state: LocalState
    try {
      state = JSON.parse(await readFile(localStatePath, 'utf8')) as LocalState
    } catch {
      throw new Error(`${label} profile not found at ${userData}. Manor will not fall back to another browser.`)
    }
    const name = state.profile?.last_used
    if (
      typeof name !== 'string' ||
      name === '' ||
      name === '.' ||
      name === '..' ||
      path.basename(name) !== name
    ) {
      throw new Error(`${label} does not report a valid active profile in its Local State file.`)
    }
    const profilePath = path.join(userData, name)
    if (!(await isDirectory(profilePath))) {
      throw new Error(`${label}'s active profile "${name}" was not found. Manor will not fall back to another browser.`)
    }
    return { name, path: profilePath }
  }

  private settingsPath(): string {
    return path.join(this.options.manorDataDirectory, SETTINGS_FILE)
  }

  private async writeSettings(settings: SnapshotSettings): Promise<void> {
    await mkdir(this.options.manorDataDirectory, { recursive: true })
    const target = this.settingsPath()
    const temporary = `${target}.tmp`
    await writeFile(temporary, `${JSON.stringify(settings)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  }
}

async function readSafeStoragePassword(homeDirectory: string, browser: ImportBrowserId): Promise<string> {
  const { keychain } = IMPORT_BROWSERS[browser]
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', `${keychain} Safe Storage`, '-a', keychain],
      {
        cwd: homeDirectory,
        encoding: 'utf8',
        env: { HOME: homeDirectory, PATH: '/usr/bin:/bin' },
        maxBuffer: 64 * 1024,
        timeout: 15_000,
      },
    )
    return stdout.trim()
  } catch {
    throw new Error(
      `Manor could not read "${keychain} Safe Storage" from the macOS Keychain. Allow access and try again.`,
    )
  }
}

function prepared(
  profilePath: string,
  fresh: boolean,
  cookies: { cookies: CookiesSetDetails[]; skippedPartitioned: number },
  logins: { logins: ImportedLogin[]; neverSaveOrigins: string[] },
  browserName: string,
): PreparedBrowserProfile {
  return {
    path: profilePath,
    fresh,
    cookies: cookies.cookies,
    logins: logins.logins,
    neverSaveOrigins: logins.neverSaveOrigins,
    ...(cookies.skippedPartitioned === 0
      ? {}
      : {
          warning: `${cookies.skippedPartitioned} partitioned ${browserName} ${
            cookies.skippedPartitioned === 1 ? 'cookie was' : 'cookies were'
          } not copied because Electron cannot preserve their partition.`,
        }),
  }
}

/** Last change per unpartitioned cookie in Manor's own database, keyed like Chromium's identity. */
function cookieFreshness(databasePath: string): Map<string, bigint> {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const columns = tableColumns(database, 'cookies')
    const changed = columns.has('last_update_utc') ? 'MAX(creation_utc, last_update_utc)' : 'creation_utc'
    const partition = columns.has('top_frame_site_key') ? "WHERE top_frame_site_key = ''" : ''
    const rows = database.prepare(`
      SELECT host_key, name, path, CAST(${changed} AS TEXT) AS changed FROM cookies ${partition}
    `).all() as Array<{ host_key: string; name: string; path: string; changed: string }>
    return new Map(rows.map((row) => [cookieKey(row), BigInt(row.changed)]))
  } finally {
    database.close()
  }
}

function cookieKey(row: { host_key: string; name: string; path: string }): string {
  return `${row.host_key}\t${row.name}\t${row.path}`
}

/**
 * Chromium's saved passwords, decrypted for Manor's own store. Federated and
 * non-website entries are skipped; "never save" rows become never-save origins.
 */
function readLogins(
  profilePath: string,
  password: string,
  browserName: string,
): { logins: ImportedLogin[]; neverSaveOrigins: string[] } {
  const logins = new Map<string, ImportedLogin>()
  const neverSave = new Set<string>()
  for (const name of LOGIN_FILES) {
    const databasePath = firstExisting([path.join(profilePath, name)])
    if (databasePath === null) continue
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const columns = tableColumns(database, 'logins')
      const optional = (column: string, fallback: string) => columns.has(column) ? column : fallback
      const rows = database.prepare(`
        SELECT signon_realm, ${optional('username_value', "''")} AS username, password_value,
               CAST(${optional('date_password_modified', optional('date_created', '0'))} AS TEXT) AS changed,
               ${optional('blacklisted_by_user', '0')} AS never
        FROM logins
      `).all() as Array<{ signon_realm: string; username: string; password_value: Uint8Array; changed: string; never: number }>
      for (const row of rows) {
        const origin = websiteOrigin(row.signon_realm)
        if (origin === null) continue
        if (row.never === 1) {
          neverSave.add(origin)
          continue
        }
        if (row.password_value.byteLength === 0) continue
        const plaintext = decryptChromiumValue(Buffer.from(row.password_value), password, row.signon_realm, false, browserName)
        if (plaintext === '') continue
        const login = {
          origin,
          username: row.username.trim(),
          password: plaintext,
          updatedAt: chromiumMilliseconds(row.changed),
        }
        const key = `${login.origin}\t${login.username}`
        const existing = logins.get(key)
        if (existing === undefined || login.updatedAt > existing.updatedAt) logins.set(key, login)
      }
    } finally {
      database.close()
    }
  }
  return { logins: [...logins.values()], neverSaveOrigins: [...neverSave] }
}

function websiteOrigin(realm: string): string | null {
  try {
    const url = new URL(realm)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

function chromiumMilliseconds(value: string): number {
  try {
    const milliseconds = Number(BigInt(value) / 1_000n) - 11_644_473_600_000
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : 0
  } catch {
    return 0
  }
}

function tableColumns(database: InstanceType<typeof DatabaseSync>, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  )
}

/**
 * The source's cookies as Electron cookie details. With `manorFreshness`, a cookie
 * Manor changed at least as recently is left alone, so the newer login of the two wins.
 */
function readCookies(
  databasePath: string,
  password: string,
  browserName: string,
  manorFreshness = new Map<string, bigint>(),
): { cookies: CookiesSetDetails[]; skippedPartitioned: number } {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const schemaVersion = cookieSchemaVersion(database, browserName)
    const columns = tableColumns(database, 'cookies')
    const partitionExpression = columns.has('top_frame_site_key')
      ? 'top_frame_site_key'
      : "''"
    const changedExpression = columns.has('last_update_utc')
      ? 'MAX(creation_utc, last_update_utc)'
      : columns.has('creation_utc') ? 'creation_utc' : '0'
    const rows = database.prepare(`
      SELECT host_key, name, path, value, encrypted_value, CAST(expires_utc AS TEXT) AS expires_utc,
             is_secure, is_httponly, samesite,
             ${partitionExpression} AS top_frame_site_key,
             CAST(${changedExpression} AS TEXT) AS changed
      FROM cookies
      ORDER BY is_secure ASC
    `).all() as Array<{
      host_key: string
      name: string
      path: string
      value: string
      encrypted_value: Uint8Array
      expires_utc: string
      is_secure: number
      is_httponly: number
      samesite: number
      top_frame_site_key: string
      changed: string
    }>
    let skippedPartitioned = 0
    const cookies = rows.flatMap((row) => {
      if (row.top_frame_site_key !== '') {
        skippedPartitioned += 1
        return []
      }
      const manorChanged = manorFreshness.get(cookieKey(row))
      if (manorChanged !== undefined && manorChanged >= BigInt(row.changed)) return []
      const encrypted = Buffer.from(row.encrypted_value)
      const value = encrypted.byteLength === 0
        ? row.value
        : decryptChromiumValue(encrypted, password, row.host_key, schemaVersion >= 24, browserName)
      const host = row.host_key.replace(/^\./, '')
      if (host === '') throw new Error(`${browserName} contains a cookie with an invalid empty host.`)
      const expirationDate = chromiumExpiration(row.expires_utc)
      if (expirationDate !== undefined && expirationDate <= Date.now() / 1_000) return []
      return [{
        url: `${row.is_secure === 1 ? 'https' : 'http'}://${host}${cookiePath(row.path)}`,
        name: row.name,
        value,
        ...(row.host_key.startsWith('.') ? { domain: row.host_key } : {}),
        path: cookiePath(row.path),
        secure: row.is_secure === 1,
        httpOnly: row.is_httponly === 1,
        sameSite: chromiumSameSite(row.samesite),
        ...(expirationDate === undefined ? {} : { expirationDate }),
      }]
    })
    return { cookies, skippedPartitioned }
  } finally {
    database.close()
  }
}

function cookieSchemaVersion(database: InstanceType<typeof DatabaseSync>, browserName: string): number {
  let row: { value: string | number } | undefined
  try {
    row = database.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      | { value: string | number }
      | undefined
  } catch {
    throw new Error(`${browserName} has a missing or malformed Chromium cookie schema version.`)
  }
  const version = Number(row?.value)
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`${browserName} has a missing or malformed Chromium cookie schema version.`)
  }
  return version
}

export function decryptChromiumValue(
  encrypted: Buffer,
  password: string,
  scope: string,
  requireScopeHash = false,
  browserName = 'The browser',
): string {
  const prefix = encrypted.subarray(0, 3).toString('ascii')
  if (prefix !== 'v10' && prefix !== 'v11') {
    throw new Error(`${browserName} uses unsupported ${prefix || 'unknown'} credential encryption.`)
  }
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
  const scopeHash = createHash('sha256').update(scope).digest()
  const hasScopeHash = decrypted.subarray(0, scopeHash.length).equals(scopeHash)
  if (requireScopeHash && !hasScopeHash) {
    throw new Error(`${browserName} cookie domain hash does not match its stored host.`)
  }
  const plaintext = hasScopeHash ? decrypted.subarray(scopeHash.length) : decrypted
  return plaintext.toString('utf8')
}

function chromiumExpiration(value: string): number | undefined {
  const microseconds = BigInt(value)
  if (microseconds === 0n) return undefined
  return Number(microseconds / 1_000n) / 1_000 - 11_644_473_600
}

function chromiumSameSite(value: number): CookiesSetDetails['sameSite'] {
  if (value === 0) return 'no_restriction'
  if (value === 1) return 'lax'
  if (value === 2) return 'strict'
  return 'unspecified'
}

function cookiePath(value: string): string {
  return value.startsWith('/') ? value : '/'
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name) || entry.isSymbolicLink()) continue
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyDirectory(from, to)
    } else if (entry.isFile()) {
      await copyFile(from, to)
    }
  }
}

/** Copies named SQLite databases with their journals; a missing database is skipped. */
async function copyDatabases(source: string, destination: string, names: string[]): Promise<void> {
  for (const name of names) {
    for (const suffix of SQLITE_SIDECARS) {
      const from = path.join(source, `${name}${suffix}`)
      if (!(await isFile(from))) continue
      await mkdir(path.dirname(path.join(destination, name)), { recursive: true, mode: 0o700 })
      await copyFile(from, path.join(destination, `${name}${suffix}`))
    }
  }
}

function removeDatabases(directory: string, names: string[]): void {
  for (const name of names) {
    for (const suffix of SQLITE_SIDECARS) rmSync(path.join(directory, `${name}${suffix}`), { force: true })
  }
}

function firstExisting(paths: string[]): string | null {
  for (const candidate of paths) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Probe the two known Chromium layouts only.
    }
  }
  return null
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isDirectory()
  } catch {
    return false
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
