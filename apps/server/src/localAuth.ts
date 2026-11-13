import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { compare, hash as hashPassword } from 'bcryptjs'
import { z } from 'zod'
import { AuthLoginRequestSchema, AuthRefreshRequestSchema, AuthErrorSchema, AuthLogoutResponseSchema, ManorSessionSchema } from '@manor/contracts'
import { SqliteRecords, transaction } from './stores/sqliteDatabase.js'

export interface LocalOwner { id: string; email: string; passwordHash: string }
interface LoginSession {
  accessHash: string
  // The access token must be returned on refresh; its bearer value stays private on disk.
  accessToken: string
  accessUntil: number
  validUntil: number
  userId: string
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')
const HOUR = 3_600_000
const singleAccount = (owners: SqliteRecords<LocalOwner>): string | undefined => {
  const accounts = [...owners.keys()]
  return accounts.length === 1 ? accounts[0] : undefined
}

/** The account answers from the network, so a short password is refused. */
export const MIN_PASSWORD_LENGTH = 12
/** bcrypt reads no further than this many bytes, so a longer password would be cut without a word. */
const MAX_PASSWORD_BYTES = 72

const SessionUser = ManorSessionSchema.shape.user

/**
 * The email as it will be stored. Checked with the schema every sign-in reply must
 * pass, so an address that could be saved but never signed in with is refused here.
 */
export function accountEmail(value: string): string {
  const email = value.trim()
  if (email.length > 320 || !SessionUser.shape.email.safeParse(email).success) throw new Error('That is not an email address.')
  return email
}

/**
 * Creates the password account, or changes its email and password. There is no signup
 * route on purpose: only someone who can already write the database on this Mac gets
 * here. Changing it ends every device session: no device connects or refreshes again
 * without the new password. A connection that is open at that moment is checked only
 * at its handshake, so it lasts until it drops or the server restarts.
 */
export async function setOwnerAccount(db: DatabaseSync, input: { email: string; password: string; ownerId?: string }): Promise<{ id: string; created: boolean }> {
  const email = accountEmail(input.email)
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new Error(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`)
  if (Buffer.byteLength(input.password) > MAX_PASSWORD_BYTES) throw new Error(`The password is too long: ${MAX_PASSWORD_BYTES} bytes is the most.`)
  const owners = new SqliteRecords<LocalOwner>(db, 'authOwner')
  if (input.ownerId !== undefined && !SessionUser.shape.id.safeParse(input.ownerId).success) throw new Error('MANOR_OWNER_USER_ID is not a user id. Remove the setting.')
  // A pinned id beside other accounts would add a second one, and a server that finds
  // two refuses every sign-in. The same state stops the server's own start.
  if (input.ownerId !== undefined && !owners.has(input.ownerId) && owners.size > 0) throw new Error('MANOR_OWNER_USER_ID names an account this database does not hold. Remove the setting.')
  if (input.ownerId === undefined && owners.size > 1) throw new Error('This database holds several accounts. Remove them with `account --remove` and create one again.')
  const passwordHash = await hashPassword(input.password, 12)
  return transaction(db, () => {
    // Decided here and not before the hash, so two runs at once still end with one account.
    const id = input.ownerId ?? singleAccount(owners) ?? (owners.size === 0 ? randomUUID() : undefined)
    if (id === undefined) throw new Error('This database holds several accounts. Remove them with `account --remove` and create one again.')
    const created = !owners.has(id)
    owners.set(id, { id, email, passwordHash })
    db.prepare("DELETE FROM records WHERE collection = 'authSessions' AND json_extract(value, '$.userId') = ?").run(id)
    return { id, created }
  })
}

/**
 * Removes every password account and device session, which closes the sign-in for
 * other devices again. The Mac itself keeps its local access key.
 */
export function removeOwnerAccounts(db: DatabaseSync): number {
  return transaction(db, () => {
    const owners = new SqliteRecords<LocalOwner>(db, 'authOwner')
    const removed = owners.size
    owners.clear()
    new SqliteRecords<LoginSession>(db, 'authSessions').clear()
    return removed
  })
}

/**
 * The password account for clients that are not on this Mac, and its revocable device
 * sessions, stored in the SQLite file. A house without an account is normal: every
 * sign-in is then refused and the local access token is the only way in. Naming an
 * owner id that the database does not hold is a broken setup and stops the start.
 * `setOwnerAccount` below is the one writer; an account it adds while the server runs
 * is found on the next sign-in, because an unpinned owner is looked up, not remembered.
 */
export class LocalAuth {
  private owners: SqliteRecords<LocalOwner>
  private sessions: SqliteRecords<LoginSession>
  private attempts = 0
  private attemptWindow = 0
  constructor(private db: DatabaseSync, private pinned?: string, private now = Date.now) {
    this.owners = new SqliteRecords(db, 'authOwner')
    this.sessions = new SqliteRecords(db, 'authSessions')
    if (pinned !== undefined && this.owners.get(pinned) === undefined) throw new Error(`MANOR_OWNER_USER_ID names an account this database does not hold. Remove the setting, or restore the database that has it.`)
  }
  private get ownerId(): string | undefined {
    return this.pinned ?? singleAccount(this.owners)
  }
  private owner(): LocalOwner {
    const owner = this.ownerId === undefined ? undefined : this.owners.get(this.ownerId)
    if (owner === undefined) throw new Error('Manor owner account is missing')
    return owner
  }
  private response(session: LoginSession, refreshToken: string) {
    const owner = this.owner()
    return ManorSessionSchema.parse({ access_token: session.accessToken, refresh_token: refreshToken, expires_at: Math.floor(session.accessUntil / 1000), user: { id: owner.id, email: owner.email } })
  }
  async signIn(email: string, password: string) {
    const now = this.now()
    if (now - this.attemptWindow >= 60_000) { this.attempts = 0; this.attemptWindow = now }
    if (++this.attempts > 20) return { status: 429, body: { error: 'Too many login attempts' } }
    if (this.ownerId === undefined) return { status: 401, body: { error: 'Invalid credentials' } }
    const owner = this.owner()
    const correct = await compare(password, owner.passwordHash)
    if (!correct || email.trim().toLowerCase() !== owner.email.toLowerCase()) return { status: 401, body: { error: 'Invalid credentials' } }
    const refreshToken = token()
    const accessToken = token()
    const session: LoginSession = { accessHash: hash(accessToken), accessToken, accessUntil: now + HOUR, validUntil: now + 30 * 24 * HOUR, userId: owner.id }
    const stored = transaction(this.db, () => {
      // The password was compared outside the transaction. A change that landed in
      // between has already ended the old sessions, so this one must not start.
      if (this.owners.get(owner.id)?.passwordHash !== owner.passwordHash) return false
      this.db.prepare("DELETE FROM records WHERE collection = 'authSessions' AND json_extract(value, '$.validUntil') <= ?").run(now)
      this.sessions.set(hash(refreshToken), session)
      return true
    })
    if (!stored) return { status: 401, body: { error: 'Invalid credentials' } }
    return { status: 200, body: this.response(session, refreshToken) }
  }
  refresh(refreshToken: string) {
    return transaction(this.db, () => {
      const key = hash(refreshToken)
      const session = this.sessions.get(key)
      if (session === undefined || this.ownerId === undefined || session.userId !== this.ownerId || session.validUntil <= this.now()) return { status: 401, body: { error: 'Session expired' } }
      const updated = { ...session, accessUntil: Math.min(this.now() + HOUR, session.validUntil) }
      this.sessions.set(key, updated)
      return { status: 200, body: this.response(updated, refreshToken) }
    })
  }
  verify(accessToken: string): boolean {
    const row = this.db.prepare("SELECT value FROM records WHERE collection = 'authSessions' AND json_extract(value, '$.accessHash') = ?").get(hash(accessToken))
    if (row === undefined) return false
    const session = JSON.parse(String(row.value)) as LoginSession
    return this.ownerId !== undefined && session.userId === this.ownerId && session.accessUntil > this.now() && session.validUntil > this.now()
  }
  logout(refreshToken: string): void { this.sessions.delete(hash(refreshToken)) }
  async handle(request: IncomingMessage, response: ServerResponse, allowedOrigins: readonly string[]): Promise<void> {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' })
      const checked = status >= 400 ? AuthErrorSchema.parse(body) : status === 204 ? null : ManorSessionSchema.or(AuthLogoutResponseSchema).parse(body)
      response.end(JSON.stringify(checked))
    }
    const origin = request.headers.origin
    if (origin !== undefined) {
      let parsed: URL
      try { parsed = new URL(origin) } catch { reply(403, { error: 'Origin refused' }); return }
      if (!['http:', 'https:'].includes(parsed.protocol) || (parsed.host !== request.headers.host && !allowedOrigins.includes(parsed.origin))) {
        reply(403, { error: 'Origin refused' }); return
      }
      response.setHeader('Access-Control-Allow-Origin', parsed.origin)
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    }
    if (request.method === 'OPTIONS') { reply(204, null); return }
    if (request.method !== 'POST') { reply(405, { error: 'POST required' }); return }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) { reply(415, { error: 'JSON required' }); return }
    try {
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        length += bytes.length
        if (length > 8192) { reply(413, { error: 'Request too large' }); return }
        chunks.push(bytes)
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (request.url === '/auth/session') {
        const body = AuthLoginRequestSchema.parse(raw)
        const result = await this.signIn(body.email, body.password)
        reply(result.status, result.body)
      } else if (request.url === '/auth/refresh') {
        const result = this.refresh(AuthRefreshRequestSchema.parse(raw).refresh_token)
        reply(result.status, result.body)
      } else if (request.url === '/auth/logout') {
        this.logout(AuthRefreshRequestSchema.parse(raw).refresh_token)
        reply(200, { ok: true })
      } else reply(404, { error: 'Unknown authentication route' })
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) reply(400, { error: 'Invalid authentication request' })
      else reply(503, { error: 'Authentication temporarily unavailable' })
    }
  }
}
