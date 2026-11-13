import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserProfileSnapshot, decryptChromiumValue } from './browserProfileSnapshot'

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('BrowserProfileSnapshot', () => {
  it('copies only Dia active profile data and keeps no credential database in the managed copy', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    const manor = path.join(root, 'manor')
    const profile = await fakeDiaProfile(home, 'Profile 2')
    await writeFile(path.join(profile, 'Preferences'), '{"signed_in":true}')
    await mkdir(path.join(profile, 'Cache'))
    await writeFile(path.join(profile, 'Cache', 'discard-me'), 'cache')
    await symlink(path.join(root, 'outside'), path.join(profile, 'escaped-link'))

    const password = 'dia-keychain-secret'
    const sourceCookie = chromiumEncrypted('session-value', password, '.example.com')
    createCredentialDatabases(profile, sourceCookie, chromiumEncrypted('saved-password', password, 'https://example.com/'))

    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home,
      manorDataDirectory: manor,
      platform: 'darwin',
      readSafeStoragePassword: async () => password,
    })

    const prepared = await snapshot.enable()
    const destination = prepared.path

    expect(await readFile(path.join(destination, 'Preferences'), 'utf8')).toBe('{"signed_in":true}')
    await expect(readFile(path.join(destination, 'Cache', 'discard-me'))).rejects.toThrow()
    await expect(readFile(path.join(destination, 'escaped-link'))).rejects.toThrow()
    await expect(readFile(path.join(destination, 'Cookies'))).rejects.toThrow()
    expect(prepared.cookies).toEqual([
      expect.objectContaining({
        url: 'http://example.com/',
        domain: '.example.com',
        name: 'session',
        value: 'session-value',
      }),
    ])
    await expect(readFile(path.join(destination, 'Login Data'))).rejects.toThrow()
    await expect(readFile(path.join(destination, 'Login Data For Account'))).rejects.toThrow()
    expect(prepared.fresh).toBe(true)
    expect(prepared.logins).toEqual([
      { origin: 'https://example.com', username: '', password: 'saved-password', updatedAt: 0 },
      { origin: 'https://account.example.com', username: '', password: 'account-password', updatedAt: 0 },
    ])
    expect(readCredential(path.join(profile, 'Cookies'), 'cookies', 'encrypted_value')).toEqual(sourceCookie)
    expect(await snapshot.status()).toMatchObject({
      enabled: true,
      available: true,
      profileName: 'Profile 2',
    })

    await snapshot.disable()
    await expect(readFile(path.join(destination, 'Preferences'))).rejects.toThrow()
    expect(await snapshot.isEnabled()).toBe(false)
  })

  it('keeps the generation across launches and merges only Dia cookies newer than Manor', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    const manor = path.join(root, 'manor')
    const profile = await fakeDiaProfile(home, 'Default')
    const password = 'dia-keychain-secret'
    createCredentialDatabases(
      profile,
      chromiumEncrypted('dia-old', password, '.example.com'),
      chromiumEncrypted('saved-password', password, 'https://example.com/'),
    )
    const options = { homeDirectory: home, manorDataDirectory: manor, platform: 'darwin' as const, readSafeStoragePassword: async () => password }
    const first = await new BrowserProfileSnapshot(options).enable()

    // What Electron wrote while the user browsed inside Manor.
    await mkdir(path.join(first.path, 'Local Storage'))
    await writeFile(path.join(first.path, 'Local Storage', 'manor-state'), 'kept')
    const manorCookies = new DatabaseSync(path.join(first.path, 'Cookies'))
    manorCookies.exec(`
      CREATE TABLE cookies (host_key TEXT, name TEXT, path TEXT, top_frame_site_key TEXT, creation_utc INTEGER, last_update_utc INTEGER);
      INSERT INTO cookies VALUES ('.example.com', 'session', '/', '', 13400000000000000, 13400000000000000);
      INSERT INTO cookies VALUES ('.example.com', 'rotated', '/', '', 13400000000000000, 13400000000000000);
    `)
    manorCookies.close()

    const dia = new DatabaseSync(path.join(profile, 'Cookies'))
    dia.exec('ALTER TABLE cookies ADD COLUMN creation_utc INTEGER DEFAULT 0')
    dia.exec('ALTER TABLE cookies ADD COLUMN last_update_utc INTEGER DEFAULT 0')
    dia.exec('UPDATE cookies SET creation_utc = 13300000000000000, last_update_utc = 13300000000000000')
    const insert = dia.prepare(`INSERT INTO cookies (host_key, name, path, value, encrypted_value, expires_utc, is_secure,
      is_httponly, samesite, top_frame_site_key, creation_utc, last_update_utc) VALUES (?, ?, '/', '', ?, 0, 0, 1, 1, '', ?, ?)`)
    insert.run('.example.com', 'rotated', chromiumEncrypted('dia-newer', password, '.example.com'), 13_500_000_000_000_000n, 13_500_000_000_000_000n)
    insert.run('.new.example', 'fresh', chromiumEncrypted('dia-new-site', password, '.new.example'), 13_500_000_000_000_000n, 13_500_000_000_000_000n)
    dia.close()
    const history = new DatabaseSync(path.join(profile, 'History'))
    history.exec("CREATE TABLE urls (url TEXT); INSERT INTO urls VALUES ('https://later.example/')")
    history.close()

    const second = await new BrowserProfileSnapshot(options).prepareEnabledSnapshot()
    expect(second).toMatchObject({ path: first.path, fresh: false })
    expect(second?.cookies.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'rotated', value: 'dia-newer' },
      { name: 'fresh', value: 'dia-new-site' },
    ])
    expect(second?.logins).toHaveLength(2)
    expect(await readFile(path.join(first.path, 'Local Storage', 'manor-state'), 'utf8')).toBe('kept')
    expect(readCredential(path.join(first.path, 'History'), 'urls', 'url').toString()).toBe('https://later.example/')
    await expect(readFile(path.join(first.path, 'Login Data'))).rejects.toThrow()
    expect((await readdir(path.join(manor, 'Dia Profile Snapshots')))).toEqual([path.basename(first.path)])
  })

  it('is off by default and fails closed when Dia is missing', async () => {
    const root = await fixtureRoot()
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: path.join(root, 'home'),
      manorDataDirectory: path.join(root, 'manor'),
      platform: 'darwin',
      readSafeStoragePassword: async () => 'unused',
    })

    expect(await snapshot.isEnabled()).toBe(false)
    await mkdir(path.join(snapshot.snapshotsPath, 'orphan'), { recursive: true })
    await writeFile(path.join(snapshot.snapshotsPath, 'orphan', 'Cookies'), 'copied credential data')
    expect(await snapshot.prepareEnabledSnapshot()).toBeNull()
    await expect(readdir(snapshot.snapshotsPath)).rejects.toThrow()
    await expect(snapshot.enable()).rejects.toThrow(
      /Dia profile not found.*Manor will not fall back to another browser/,
    )
    expect(await snapshot.status()).toMatchObject({ enabled: false, available: false })
  })

  it('removes a staged personal profile when first-time enablement fails', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    const manor = path.join(root, 'manor')
    const profile = await fakeDiaProfile(home, 'Default')
    await writeFile(path.join(profile, 'Preferences'), '{"private":"context"}')
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home,
      manorDataDirectory: manor,
      platform: 'darwin',
      readSafeStoragePassword: async () => 'secret',
    })

    await expect(snapshot.enable()).rejects.toThrow(/no Chromium Cookies database/)
    await expect(readdir(snapshot.snapshotsPath)).rejects.toThrow()
    expect(await snapshot.isEnabled()).toBe(false)
  })

  it('omits partitioned cookies instead of changing their identity', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    const profile = await fakeDiaProfile(home, 'Default')
    const password = 'dia-keychain-secret'
    createCredentialDatabases(
      profile,
      chromiumEncrypted('session-value', password, '.example.com'),
      chromiumEncrypted('saved-password', password, 'https://example.com/'),
      'https://top-frame.example',
    )
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home,
      manorDataDirectory: path.join(root, 'manor'),
      platform: 'darwin',
      readSafeStoragePassword: async () => password,
    })

    const prepared = await snapshot.enable()
    expect(prepared.cookies).toEqual([])
    expect(prepared.warning).toMatch(/1 partitioned Dia cookie was not copied/)
    expect(await snapshot.status()).toMatchObject({ enabled: true, warning: prepared.warning })
    await snapshot.disable()
  })

  it('reads Chromium expiration timestamps beyond JavaScript safe integers', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    const profile = await fakeDiaProfile(home, 'Default')
    const password = 'dia-keychain-secret'
    createCredentialDatabases(
      profile,
      chromiumEncrypted('session-value', password, '.example.com'),
      chromiumEncrypted('saved-password', password, 'https://example.com/'),
      '',
      13_423_567_067_028_269n,
    )
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home,
      manorDataDirectory: path.join(root, 'manor'),
      platform: 'darwin',
      readSafeStoragePassword: async () => password,
    })

    const prepared = await snapshot.enable()
    expect(prepared.cookies).toEqual([])
    await snapshot.disable()
  })

  it('imports insecure cookies before a conflicting Secure cookie', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    const profile = await fakeDiaProfile(home, 'Default')
    const password = 'dia-keychain-secret'
    createCredentialDatabases(
      profile,
      chromiumEncrypted('secure-value', password, '.example.com'),
      chromiumEncrypted('saved-password', password, 'https://example.com/'),
    )
    const cookies = new DatabaseSync(path.join(profile, 'Cookies'))
    cookies.exec('UPDATE cookies SET is_secure = 1')
    cookies.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      '.example.com',
      'session',
      '/',
      '',
      chromiumEncrypted('insecure-value', password, '.example.com'),
      0,
      0,
      1,
      1,
      '',
    )
    cookies.close()
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home,
      manorDataDirectory: path.join(root, 'manor'),
      platform: 'darwin',
      readSafeStoragePassword: async () => password,
    })

    const prepared = await snapshot.enable()
    expect(prepared.cookies.map(({ secure, value }) => ({ secure, value }))).toEqual([
      { secure: false, value: 'insecure-value' },
      { secure: true, value: 'secure-value' },
    ])
    await snapshot.disable()
  })

  it('does not bypass domain validation when Dia cookie schema metadata is malformed', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    const profile = await fakeDiaProfile(home, 'Default')
    const password = 'dia-keychain-secret'
    createCredentialDatabases(
      profile,
      chromiumEncrypted('session-value', password, '.example.com'),
      chromiumEncrypted('saved-password', password, 'https://example.com/'),
    )
    const cookies = new DatabaseSync(path.join(profile, 'Cookies'))
    cookies.exec("UPDATE meta SET value = 0 WHERE key = 'version'")
    cookies.close()
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home,
      manorDataDirectory: path.join(root, 'manor'),
      platform: 'darwin',
      readSafeStoragePassword: async () => password,
    })

    await expect(snapshot.enable()).rejects.toThrow(/malformed Chromium cookie schema version/)
    await expect(readdir(snapshot.snapshotsPath)).rejects.toThrow()
  })

  it('rejects another platform instead of probing a Chrome-shaped path', async () => {
    const root = await fixtureRoot()
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: path.join(root, 'home'),
      manorDataDirectory: path.join(root, 'manor'),
      platform: 'linux',
    })

    await expect(snapshot.enable()).rejects.toThrow(/only available.*macOS/)
  })

  it('rejects a parent-directory active profile from corrupt Dia state', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    const userData = path.join(home, 'Library', 'Application Support', 'Dia', 'User Data')
    await mkdir(userData, { recursive: true })
    await writeFile(path.join(userData, 'Local State'), JSON.stringify({ profile: { last_used: '..' } }))
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home,
      manorDataDirectory: path.join(root, 'manor'),
      platform: 'darwin',
    })

    await expect(snapshot.enable()).rejects.toThrow(/valid active profile/)
  })
})

describe('choosing the browser to copy from', () => {
  const password = 'dia-keychain-secret'
  const seed = (profile: string, value: string) => createCredentialDatabases(
    profile,
    chromiumEncrypted(value, password, '.example.com'),
    chromiumEncrypted('saved-password', password, 'https://example.com/'),
  )

  it('lists every browser, marks the ones on this Mac and offers the first of those', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    await fakeProfile(home, ['BraveSoftware', 'Brave-Browser'], 'Default')
    await fakeDiaProfile(home, 'Default')
    const snapshot = new BrowserProfileSnapshot({ homeDirectory: home, manorDataDirectory: path.join(root, 'manor'), platform: 'darwin' })

    const status = await snapshot.status()
    expect(status).toMatchObject({ enabled: false, available: true, browser: 'brave', profileName: 'Default' })
    expect(status.browsers).toEqual([
      { id: 'chrome', name: 'Chrome', installed: false },
      { id: 'arc', name: 'Arc', installed: false },
      { id: 'brave', name: 'Brave', installed: true },
      { id: 'edge', name: 'Edge', installed: false },
      { id: 'dia', name: 'Dia', installed: true },
    ])
  })

  it("copies from the named browser with that browser's Keychain item, and remembers the choice", async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    seed(await fakeProfile(home, ['Google', 'Chrome'], 'Profile 1'), 'chrome-session')
    seed(await fakeDiaProfile(home, 'Default'), 'dia-session')
    const asked: string[] = []
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home,
      manorDataDirectory: path.join(root, 'manor'),
      platform: 'darwin',
      readSafeStoragePassword: async (browser) => {
        asked.push(browser)
        return password
      },
    })

    const prepared = await snapshot.enable('chrome')
    expect(prepared.cookies).toEqual([expect.objectContaining({ value: 'chrome-session' })])
    expect(asked).toEqual(['chrome'])
    expect(await snapshot.status()).toMatchObject({ enabled: true, browser: 'chrome', profileName: 'Profile 1' })

    // The next launch merges from the same browser without being told again.
    await snapshot.prepareEnabledSnapshot()
    expect(asked).toEqual(['chrome', 'chrome'])

    // Another browser replaces the copy; there is one generation, never two.
    const switched = await snapshot.enable('dia')
    expect(switched.fresh).toBe(true)
    expect(switched.cookies).toEqual([expect.objectContaining({ value: 'dia-session' })])
    expect(await readdir(snapshot.snapshotsPath)).toEqual([path.basename(switched.path)])

    // Off deletes the copy and keeps the choice for the next time it is switched on.
    await snapshot.disable()
    expect(await snapshot.status()).toMatchObject({ enabled: false, browser: 'dia' })
  })

  it('keeps the old copy when a switch to another browser fails', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    seed(await fakeDiaProfile(home, 'Default'), 'dia-session')
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home, manorDataDirectory: path.join(root, 'manor'), platform: 'darwin',
      readSafeStoragePassword: async () => password,
    })
    const first = await snapshot.enable('dia')

    await expect(snapshot.enable('arc')).rejects.toThrow(/Arc profile not found/)
    expect(await snapshot.status()).toMatchObject({ enabled: true, browser: 'dia' })
    expect(await readdir(snapshot.snapshotsPath)).toEqual([path.basename(first.path)])
  })

  // A consent file written before there was a choice holds no browser. It meant Dia.
  it('reads a consent given before there was a choice as Dia', async () => {
    const root = await fixtureRoot()
    const home = path.join(root, 'home')
    const manor = path.join(root, 'manor')
    seed(await fakeProfile(home, ['Google', 'Chrome'], 'Default'), 'chrome-session')
    seed(await fakeDiaProfile(home, 'Default'), 'dia-session')
    await mkdir(manor, { recursive: true })
    await writeFile(path.join(manor, 'dia-profile-snapshot.json'), '{"enabled":true}\n')
    const snapshot = new BrowserProfileSnapshot({
      homeDirectory: home, manorDataDirectory: manor, platform: 'darwin',
      readSafeStoragePassword: async () => password,
    })

    expect(await snapshot.status()).toMatchObject({ enabled: true, browser: 'dia' })
    const prepared = await snapshot.prepareEnabledSnapshot()
    expect(prepared?.cookies).toEqual([expect.objectContaining({ value: 'dia-session' })])
  })
})

describe('Chromium credential decryption', () => {
  it('handles the host digest used by current Chromium cookie databases', () => {
    const password = 'safe-storage'
    const encrypted = chromiumEncrypted('cookie', password, '.manor.test')
    expect(decryptChromiumValue(encrypted, password, '.manor.test', true)).toBe('cookie')
    expect(() => decryptChromiumValue(encrypted, password, '.other.test', true)).toThrow(
      /domain hash does not match/,
    )
  })

  it('fails explicitly for unsupported app-bound encryption', () => {
    expect(() => decryptChromiumValue(Buffer.from('v20ciphertext'), 'secret', 'scope')).toThrow(
      /unsupported v20 credential encryption/,
    )
  })
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manor-dia-profile-'))
  roots.push(root)
  return root
}

const fakeDiaProfile = (home: string, active: string) => fakeProfile(home, ['Dia', 'User Data'], active)

async function fakeProfile(home: string, folder: string[], active: string): Promise<string> {
  const userData = path.join(home, 'Library', 'Application Support', ...folder)
  const profile = path.join(userData, active)
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(userData, 'Local State'), JSON.stringify({ profile: { last_used: active } }))
  return profile
}

function createCredentialDatabases(
  profile: string,
  cookie: Buffer,
  password: Buffer,
  topFrameSiteKey = '',
  expiresUtc: number | bigint = 0,
): void {
  const cookies = new DatabaseSync(path.join(profile, 'Cookies'))
  cookies.exec(`
    CREATE TABLE meta (key TEXT, value INTEGER);
    INSERT INTO meta VALUES ('version', 24);
    CREATE TABLE cookies (
      host_key TEXT, name TEXT, path TEXT, value TEXT, encrypted_value BLOB,
      expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
      top_frame_site_key TEXT
    )
  `)
  cookies.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    '.example.com', 'session', '/', '', cookie, expiresUtc, 0, 1, 1, topFrameSiteKey,
  )
  cookies.close()

  const logins = new DatabaseSync(path.join(profile, 'Login Data'))
  logins.exec('CREATE TABLE logins (signon_realm TEXT, password_value BLOB)')
  logins.prepare('INSERT INTO logins VALUES (?, ?)').run('https://example.com/', password)
  logins.close()

  const accountLogins = new DatabaseSync(path.join(profile, 'Login Data For Account'))
  accountLogins.exec('CREATE TABLE logins (signon_realm TEXT, password_value BLOB)')
  accountLogins.prepare('INSERT INTO logins VALUES (?, ?)').run(
    'https://account.example.com/',
    chromiumEncrypted('account-password', 'dia-keychain-secret', 'https://account.example.com/'),
  )
  accountLogins.close()
}

function readCredential(databasePath: string, table: string, column: string): Buffer {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = database.prepare(`SELECT ${column} AS value FROM ${table}`).get() as { value: Uint8Array | string }
    return Buffer.from(row.value)
  } finally {
    database.close()
  }
}

function chromiumEncrypted(plaintext: string, password: string, scope: string): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const digest = createHash('sha256').update(scope).digest()
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(Buffer.concat([digest, Buffer.from(plaintext)])),
    cipher.final(),
  ])
}
