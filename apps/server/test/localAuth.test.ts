import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { hash } from 'bcryptjs'
import { openSqlite, SqliteRecords } from '../src/stores/sqliteDatabase.js'
import { LocalAuth, removeOwnerAccounts, setOwnerAccount } from '../src/localAuth.js'
const owner = '11111111-1111-4111-8111-111111111111'
const databases: ReturnType<typeof openSqlite>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
async function fixture() {
  const db = openSqlite(':memory:')
  databases.push(db)
  new SqliteRecords(db, 'authOwner').set(owner, { id: owner, email: 'owner@example.invalid', passwordHash: await hash('original-password', 4) })
  let now = 1_000_000
  return { db, auth: new LocalAuth(db, owner, () => now), advance: (ms: number) => { now += ms } }
}

describe('the password account', () => {
  const open = () => { const db = openSqlite(':memory:'); databases.push(db); return db }

  it('is found by a running server that started without one, and a new password signs devices out', async () => {
    const db = open()
    const auth = new LocalAuth(db)
    expect((await auth.signIn('robin@example.invalid', 'a-long-enough-password')).status).toBe(401)

    const made = await setOwnerAccount(db, { email: ' Robin@example.invalid ', password: 'a-long-enough-password' })
    expect(made.created).toBe(true)
    const session = await auth.signIn('robin@example.invalid', 'a-long-enough-password')
    if (!('access_token' in session.body)) throw new Error('expected a session')
    expect(auth.verify(session.body.access_token)).toBe(true)

    const changed = await setOwnerAccount(db, { email: 'robin@example.invalid', password: 'another-long-password' })
    expect(changed).toEqual({ id: made.id, created: false })
    expect(auth.verify(session.body.access_token)).toBe(false)
    expect(auth.refresh(session.body.refresh_token).status).toBe(401)
    expect((await auth.signIn('robin@example.invalid', 'a-long-enough-password')).status).toBe(401)
    expect((await auth.signIn('robin@example.invalid', 'another-long-password')).status).toBe(200)
  })

  it('refuses what would make a weak or unusable account, and writes nothing', async () => {
    const db = open()
    await expect(setOwnerAccount(db, { email: 'robin', password: 'a-long-enough-password' })).rejects.toThrow('email')
    // Each of these could be stored, but the sign-in reply is checked as a real address and would fail every time.
    for (const email of ['me@mac', 'robin@localhost', 'rené@example.invalid']) {
      await expect(setOwnerAccount(db, { email, password: 'a-long-enough-password' })).rejects.toThrow('email')
    }
    await expect(setOwnerAccount(db, { email: 'robin@example.invalid', password: 'a-long-enough-password', ownerId: 'sam' })).rejects.toThrow('not a user id')
    await expect(setOwnerAccount(db, { email: 'robin@example.invalid', password: 'short' })).rejects.toThrow('at least 12')
    await expect(setOwnerAccount(db, { email: 'robin@example.invalid', password: 'é'.repeat(40) })).rejects.toThrow('too long')
    expect(new SqliteRecords(db, 'authOwner').size).toBe(0)
  })

  it('does not guess between several accounts, never adds a second one, and can remove them all', async () => {
    const db = open()
    const owners = new SqliteRecords(db, 'authOwner')
    const account = await setOwnerAccount(db, { email: 'robin@example.invalid', password: 'a-long-enough-password' })
    // A pinned id the database does not hold would put a second account beside the first.
    await expect(setOwnerAccount(db, { email: 'sam@example.invalid', password: 'a-long-enough-password', ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).rejects.toThrow('does not hold')
    expect(owners.size).toBe(1)

    owners.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'b@example.invalid', passwordHash: 'x' })
    await expect(setOwnerAccount(db, { email: 'robin@example.invalid', password: 'a-long-enough-password' })).rejects.toThrow('--remove')
    expect((await setOwnerAccount(db, { email: 'robin@example.invalid', password: 'a-long-enough-password', ownerId: account.id })).created).toBe(false)

    const auth = new LocalAuth(db, account.id)
    const session = await auth.signIn('robin@example.invalid', 'a-long-enough-password')
    if (!('access_token' in session.body)) throw new Error('expected a session')
    expect(removeOwnerAccounts(db)).toBe(2)
    expect(auth.verify(session.body.access_token)).toBe(false)
    expect(removeOwnerAccounts(db)).toBe(0)
    expect((await setOwnerAccount(db, { email: 'robin@example.invalid', password: 'a-long-enough-password' })).created).toBe(true)
  })

  it('refuses a sign-in whose password was changed while it was being checked', async () => {
    const db = open()
    await setOwnerAccount(db, { email: 'robin@example.invalid', password: 'a-long-enough-password' })
    const auth = new LocalAuth(db)
    // The old password is still being compared when the new one lands.
    const racing = auth.signIn('robin@example.invalid', 'a-long-enough-password')
    const owners = new SqliteRecords<{ id: string; email: string; passwordHash: string }>(db, 'authOwner')
    const [id, owner] = [...owners.entries()][0] ?? []
    if (id === undefined || owner === undefined) throw new Error('expected an account')
    owners.set(id, { ...owner, passwordHash: await hash('another-long-password', 4) })
    expect((await racing).status).toBe(401)
    expect(new SqliteRecords(db, 'authSessions').size).toBe(0)
  })
})

describe('local owner authentication', () => {
  it('keeps the imported password, rejects strangers and revokes a device session', async () => {
    const { auth } = await fixture()
    expect((await auth.signIn('owner@example.invalid', 'wrong')).status).toBe(401)
    expect((await auth.signIn('stranger@example.invalid', 'original-password')).status).toBe(401)
    const result = await auth.signIn('owner@example.invalid', 'original-password')
    expect(result.status).toBe(200)
    if (!('access_token' in result.body)) throw new Error('expected a session')
    expect(auth.verify(result.body.access_token)).toBe(true)
    expect(auth.verify('invented-token')).toBe(false)
    expect(auth.refresh(result.body.refresh_token).status).toBe(200)
    auth.logout(result.body.refresh_token)
    expect(auth.verify(result.body.access_token)).toBe(false)
    expect(auth.refresh(result.body.refresh_token).status).toBe(401)
  })
  it('expires access and eventually the refresh credential', async () => {
    const { auth, advance } = await fixture()
    const result = await auth.signIn('owner@example.invalid', 'original-password')
    if (!('access_token' in result.body)) throw new Error('expected a session')
    advance(3_600_001)
    expect(auth.verify(result.body.access_token)).toBe(false)
    expect(auth.refresh(result.body.refresh_token).status).toBe(200)
    expect(auth.verify(result.body.access_token)).toBe(true)
    advance(30 * 24 * 3_600_000)
    expect(auth.refresh(result.body.refresh_token).status).toBe(401)
  })
  it('refuses a hostile browser origin and accepts the authenticated phone request without Origin', async () => {
    const { auth } = await fixture()
    const server = createServer((req, res) => { void auth.handle(req, res, []) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const url = `http://127.0.0.1:${address.port}/auth/session`
    try {
      const body = JSON.stringify({ email: 'owner@example.invalid', password: 'original-password' })
      expect((await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' } })).status).toBe(403)
      const phone = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
      expect(phone.status).toBe(200)
      expect(phone.headers.get('cache-control')).toBe('no-store')
      expect((await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })).status).toBe(415)
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  })
})
