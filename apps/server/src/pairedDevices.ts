import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { PAIRING_PATH, PairDeviceResponseSchema, PairErrorSchema, PairRedeemRequestSchema, PairRedeemResponseSchema } from '@manor/contracts'

/** How long a pairing link from Settings works. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000
/** Links alive at once; making another drops the oldest. */
const MAX_LIVE_CODES = 5

const secret = () => randomBytes(32).toString('base64url')
const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
const sameDigest = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b)

export interface PairedDeviceRow {
  id: string
  name: string
  pairedAt: number
  lastSeenAt: number | null
}

/**
 * The devices other than this Mac that may open Manor: a phone or a browser, each
 * paired once through a one-time link. A pairing code lives only in memory, as a hash,
 * for ten minutes and one use; a restart forgets every open link. The device token
 * handed out for it is `<device id>.<secret>`, and the database keeps only the hash of
 * the secret. Both are compared in constant time.
 */
export class PairedDevices {
  private codes: { hash: Buffer; expiresAt: number }[] = []

  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  /** A fresh one-time code. The caller shows it once; nothing keeps it in clear. */
  createCode(): { code: string; expiresAt: number } {
    const at = this.now()
    const code = secret()
    const expiresAt = at + PAIRING_CODE_TTL_MS
    this.codes = [...this.codes.filter((entry) => entry.expiresAt > at), { hash: digest(code), expiresAt }].slice(-MAX_LIVE_CODES)
    return { code, expiresAt }
  }

  /** Spends the code and pairs a device, or null when the code is unknown, used or expired. */
  redeem(code: string, name: string): { token: string; deviceId: string } | null {
    const at = this.now()
    const hash = digest(code)
    // Every live code is compared, so how long a miss takes says nothing about which one was close.
    let match: (typeof this.codes)[number] | undefined
    for (const entry of this.codes) if (sameDigest(entry.hash, hash) && entry.expiresAt > at) match = entry
    if (match === undefined) return null
    this.codes = this.codes.filter((entry) => entry !== match && entry.expiresAt > at)
    const deviceId = randomUUID()
    const deviceSecret = secret()
    this.db.prepare('INSERT INTO paired_devices (id, name, secret_hash, paired_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(deviceId, name, digest(deviceSecret).toString('hex'), at, at)
    return { token: `${deviceId}.${deviceSecret}`, deviceId }
  }

  /** The device a token belongs to, or undefined for anything else. */
  verify(token: string): string | undefined {
    const dot = token.indexOf('.')
    if (dot <= 0) return undefined
    const id = token.slice(0, dot)
    const row = this.db.prepare('SELECT secret_hash FROM paired_devices WHERE id = ?').get(id)
    if (row === undefined) return undefined
    return sameDigest(Buffer.from(String(row.secret_hash), 'hex'), digest(token.slice(dot + 1))) ? id : undefined
  }

  touch(deviceId: string): void {
    this.db.prepare('UPDATE paired_devices SET last_seen_at = ? WHERE id = ?').run(this.now(), deviceId)
  }

  name(deviceId: string): string | undefined {
    const row = this.db.prepare('SELECT name FROM paired_devices WHERE id = ?').get(deviceId)
    return row === undefined ? undefined : String(row.name)
  }

  list(): PairedDeviceRow[] {
    return this.db.prepare('SELECT id, name, paired_at, last_seen_at FROM paired_devices ORDER BY paired_at DESC').all().map((row) => ({
      id: String(row.id),
      name: String(row.name),
      pairedAt: Number(row.paired_at),
      lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
    }))
  }

  /** The push address a device registered over its own socket, so a revoke can drop it. */
  notePushToken(deviceId: string, token: string): void {
    this.db.prepare('UPDATE paired_devices SET push_token = ? WHERE id = ?').run(token, deviceId)
  }

  pushToken(deviceId: string): string | null {
    const row = this.db.prepare('SELECT push_token FROM paired_devices WHERE id = ?').get(deviceId)
    return row === undefined || row.push_token === null ? null : String(row.push_token)
  }

  /** True when the device was paired; its token stops working at once. */
  revoke(deviceId: string): boolean {
    return Number(this.db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId).changes) > 0
  }
}

const bearer = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length).trim() : undefined
}

export const handlesPairingRequest = (request: IncomingMessage): boolean =>
  (request.url === PAIRING_PATH && request.method !== 'GET' && request.method !== 'HEAD') || request.url === `${PAIRING_PATH}/device`

/**
 * The HTTP side of pairing. `POST /pair` spends a code, `GET /pair/device` tells a
 * device whether the Mac still knows it and `DELETE /pair/device` forgets it from the
 * device itself. `GET /pair` is the web app's own page and goes to the static files.
 * Browsers must come from an allowed origin; the phone sends none.
 */
export async function handlePairingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  devices: PairedDevices,
  options: { allowedOrigins: readonly string[]; onChange: () => void; onForget: (deviceId: string) => void },
): Promise<void> {
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' })
    response.end(status === 204 ? undefined : JSON.stringify(body))
  }
  const origin = request.headers.origin
  if (origin !== undefined) {
    let parsed: URL
    try { parsed = new URL(origin) } catch { reply(403, PairErrorSchema.parse({ error: 'Origin refused' })); return }
    if (!['http:', 'https:'].includes(parsed.protocol) || (parsed.host !== request.headers.host && !options.allowedOrigins.includes(parsed.origin))) {
      reply(403, PairErrorSchema.parse({ error: 'Origin refused' }))
      return
    }
    response.setHeader('Access-Control-Allow-Origin', parsed.origin)
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  }
  if (request.method === 'OPTIONS') { reply(204, null); return }

  if (request.url === `${PAIRING_PATH}/device`) {
    const token = bearer(request)
    const deviceId = token === undefined ? undefined : devices.verify(token)
    if (deviceId === undefined) { reply(401, { error: 'Not paired' }); return }
    if (request.method === 'GET') {
      reply(200, PairDeviceResponseSchema.parse({ deviceId, name: devices.name(deviceId) ?? '' }))
      return
    }
    if (request.method === 'DELETE') {
      options.onForget(deviceId)
      reply(200, { ok: true })
      return
    }
    reply(405, { error: 'GET or DELETE required' })
    return
  }

  if (request.method !== 'POST') { reply(405, { error: 'POST required' }); return }
  if (request.headers['content-type']?.toLowerCase().startsWith('application/json') !== true) { reply(415, { error: 'JSON required' }); return }
  try {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > 4096) { reply(413, { error: 'Request too large' }); return }
      chunks.push(bytes)
    }
    const body = PairRedeemRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const paired = devices.redeem(body.code, body.name)
    if (paired === null) { reply(410, { error: 'This pairing link has expired or was already used.' }); return }
    options.onChange()
    reply(200, PairRedeemResponseSchema.parse(paired))
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) reply(400, { error: 'Invalid pairing request' })
    else reply(503, { error: 'Pairing is unavailable right now' })
  }
}
