import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserPasswordStore, loginOrigin, type PasswordCipher } from './browserPasswords'

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')
const cipher: PasswordCipher = {
  encrypt: (plaintext) => Buffer.from('x:' + plaintext),
  decrypt: (encrypted) => encrypted.toString().slice(2),
}
const roots: string[] = []
const stores: BrowserPasswordStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function openStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manor-passwords-'))
  roots.push(root)
  const file = path.join(root, 'nested', 'passwords.sqlite')
  const store = new BrowserPasswordStore(file, cipher)
  stores.push(store)
  return { store, file }
}

describe('BrowserPasswordStore', () => {
  it('round-trips a saved login through the cipher and never stores the plaintext', async () => {
    const { store, file } = await openStore()
    const saved = store.save('https://github.com/login', '  ada  ', 'hunter2')

    expect(saved).toMatchObject({ origin: 'https://github.com', username: 'ada', source: 'manor' })
    expect(JSON.stringify(saved)).not.toContain('hunter2')
    expect(store.forOrigin('https://github.com')).toEqual([saved])
    expect(store.credential(saved.id)).toEqual({ origin: 'https://github.com', username: 'ada', password: 'hunter2' })
    expect(store.credential('missing')).toBeNull()

    const raw = new DatabaseSync(file)
    const row = raw.prepare('SELECT password FROM browser_logins WHERE id = ?').get(saved.id)
    raw.close()
    expect(Buffer.from(row?.password as Uint8Array).toString()).toBe('x:hunter2')
    expect(Buffer.from(row?.password as Uint8Array).toString()).not.toBe('hunter2')
  })

  it('offers save for a new username, update for a changed password, and nothing for an identical one', async () => {
    const { store } = await openStore()
    store.save('https://a.com', 'ada', 'one')

    expect(store.offerFor('https://a.com', 'ada', 'one')).toBeNull()
    expect(store.offerFor('https://a.com', 'ada', 'two')).toEqual({ kind: 'update' })
    expect(store.offerFor('https://a.com', 'grace', 'one')).toEqual({ kind: 'save' })
    expect(store.offerFor('https://a.com', '', 'pin')).toEqual({ kind: 'save' })
  })

  it('suppresses offers on never-save origins until a login is saved there', async () => {
    const { store } = await openStore()
    store.neverSave('https://a.com/anything')

    expect(store.isNeverSave('https://a.com')).toBe(true)
    expect(store.isNeverSave('https://b.com')).toBe(false)
    expect(store.offerFor('https://a.com', 'ada', 'one')).toBeNull()

    store.save('https://a.com', 'ada', 'one')
    expect(store.isNeverSave('https://a.com')).toBe(false)
    expect(store.offerFor('https://a.com', 'ada', 'two')).toEqual({ kind: 'update' })
  })

  it('matches origins exactly, treating a signon_realm like the plain origin', async () => {
    const { store } = await openStore()
    store.save('https://a.com', 'root', 'p1')
    store.save('https://sub.a.com', 'sub', 'p2')
    store.save('http://a.com', 'plain', 'p3')

    expect(store.forOrigin('https://a.com').map((login) => login.username)).toEqual(['root'])
    expect(store.forOrigin('https://a.com/').map((login) => login.username)).toEqual(['root'])
    expect(store.forOrigin('https://sub.a.com').map((login) => login.username)).toEqual(['sub'])
    expect(store.forOrigin('http://a.com').map((login) => login.username)).toEqual(['plain'])
    expect(store.forOrigin('https://a.com:8443')).toEqual([])
    expect(store.list().map((login) => login.origin)).toEqual(['http://a.com', 'https://a.com', 'https://sub.a.com'])
    expect(loginOrigin('https://github.com/')).toBe('https://github.com')
    expect(loginOrigin('http://localhost:3000/x?y=1')).toBe('http://localhost:3000')
    expect(loginOrigin('ftp://a.com')).toBeNull()
    expect(loginOrigin('not a url')).toBeNull()
  })

  it('replaceImported lets the newest login win in both directions and drops vanished Dia rows', async () => {
    const { store } = await openStore()
    const older = store.save('https://old.com', 'ada', 'manor-old')
    const oldTime = older.updatedAt
    store.save('https://new.com', 'ada', 'manor-new')

    store.replaceImported([
      { origin: 'https://old.com/', username: 'ada', password: 'dia-newer', updatedAt: oldTime + 1000 },
      { origin: 'https://new.com', username: 'ada', password: 'dia-older', updatedAt: 1 },
      { origin: 'https://gone.com', username: 'bob', password: 'dia-gone', updatedAt: 5 },
      { origin: 'chrome://settings', username: 'skip', password: 'invalid-origin', updatedAt: 5 },
    ], [])

    const byOrigin = (origin: string) => {
      const login = store.forOrigin(origin)[0]
      if (!login) throw new Error(`No login for ${origin}`)
      return login
    }
    expect(byOrigin('https://old.com')).toMatchObject({ source: 'dia', updatedAt: oldTime + 1000 })
    expect(store.credential(byOrigin('https://old.com').id)?.password).toBe('dia-newer')
    expect(byOrigin('https://new.com').source).toBe('manor')
    expect(store.credential(byOrigin('https://new.com').id)?.password).toBe('manor-new')
    expect(store.forOrigin('https://gone.com')).toHaveLength(1)
    expect(store.list()).toHaveLength(3)

    store.replaceImported([{ origin: 'https://old.com', username: 'ada', password: 'dia-v2', updatedAt: oldTime + 2000 }], [])
    expect(store.forOrigin('https://gone.com')).toEqual([])
    expect(store.credential(byOrigin('https://old.com').id)?.password).toBe('dia-v2')
    expect(store.list()).toHaveLength(2)
  })

  it('replaceImported refreshes Dia never-save origins without overriding Manor choices', async () => {
    const { store } = await openStore()
    store.neverSave('https://manor.com')
    store.save('https://has-login.com', 'ada', 'pw')
    store.replaceImported([], ['https://dia.com/', 'https://manor.com', 'https://has-login.com', 'about:blank'])

    expect(store.isNeverSave('https://dia.com')).toBe(true)
    // Dia's Never holds even beside a saved login: no offer for another username there.
    expect(store.offerFor('https://has-login.com', 'ada', 'changed')).toBeNull()
    expect(store.neverSaveList()).toEqual([
      { origin: 'https://dia.com', source: 'dia' },
      { origin: 'https://has-login.com', source: 'dia' },
      { origin: 'https://manor.com', source: 'manor' },
    ])

    store.replaceImported([], [])
    expect(store.isNeverSave('https://dia.com')).toBe(false)
    expect(store.isNeverSave('https://manor.com')).toBe(true)
  })

  it('clearImported keeps what the user saved in Manor', async () => {
    const { store } = await openStore()
    store.save('https://mine.com', 'ada', 'pw')
    store.replaceImported([{ origin: 'https://dia.com', username: 'bob', password: 'pw', updatedAt: 1 }], ['https://nope.com'])
    store.neverSave('https://kept.com')

    store.clearImported()

    expect(store.list().map((login) => login.origin)).toEqual(['https://mine.com'])
    expect(store.isNeverSave('https://nope.com')).toBe(false)
    expect(store.isNeverSave('https://kept.com')).toBe(true)
  })

  it('removes one login or everything, Dia copies and never-save marks included', async () => {
    const { store } = await openStore()
    const first = store.save('https://a.com', 'ada', 'pw')
    store.save('https://b.com', 'bob', 'pw')
    store.neverSave('https://c.com')
    store.replaceImported([{ origin: 'https://dia.com', username: 'dee', password: 'pw', updatedAt: 1 }], ['https://dia-never.com'])

    store.remove(first.id)
    expect(store.list().map((login) => login.origin)).toEqual(['https://b.com', 'https://dia.com'])

    store.removeAll()
    expect(store.list()).toEqual([])
    expect(store.isNeverSave('https://c.com')).toBe(false)
    expect(store.isNeverSave('https://dia-never.com')).toBe(false)
  })

  it('lifts Never for one site, from Manor or Dia', async () => {
    const { store } = await openStore()
    store.neverSave('https://mine.com')
    store.replaceImported([], ['https://dia.com'])
    store.allowSaving('https://mine.com/login')
    store.allowSaving('https://dia.com')
    expect(store.offerFor('https://mine.com', 'ada', 'pw')).toEqual({ kind: 'save' })
    expect(store.isNeverSave('https://dia.com')).toBe(false)
  })

  it('rejects non-web origins and values over the length caps', async () => {
    const { store } = await openStore()

    expect(() => store.save('file:///etc/passwd', 'ada', 'pw')).toThrow('Only HTTP and HTTPS sites can save passwords.')
    expect(() => store.neverSave('not a url')).toThrow('Only HTTP and HTTPS sites can save passwords.')
    expect(() => store.forOrigin('chrome://settings')).toThrow('Only HTTP and HTTPS sites can save passwords.')
    expect(() => store.save('https://a.com', 'ada', '')).toThrow()
    expect(() => store.save('https://a.com', 'ada', 'p'.repeat(4097))).toThrow()
    expect(() => store.save('https://a.com', 'u'.repeat(501), 'pw')).toThrow()
    expect(store.save('https://a.com', 'ada', 'p'.repeat(4096)).id).toBeTruthy()
    expect(store.credential(store.list()[0]?.id ?? '')?.password).toHaveLength(4096)
  })
})
