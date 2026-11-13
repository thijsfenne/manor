import { describe, expect, it, vi } from 'vitest'
import {
  createGate,
  createTokenGate,
  createUpgradeGuard,
  openGate,
  rejectUpgrade,
  type UpgradeSocket,
  type VerifyToken,
} from '../src/auth.js'

/** A verifier with no network: one known-good token, everything else refused. */
const only = (good: string): VerifyToken => (token) => Promise.resolve(token === good)

/** Clock a test drives by hand, so the cache window is provable without waiting. */
function clock(start = 1_000) {
  let value = start
  return { now: () => value, advance: (ms: number) => (value += ms) }
}

function fakeSocket() {
  const written: string[] = []
  let destroyed = false
  const socket: UpgradeSocket = {
    write: (data) => written.push(data),
    destroy: () => {
      destroyed = true
    },
  }
  return { socket, written, isDestroyed: () => destroyed }
}

describe('token gate', () => {
  it('verifies a token once and then answers from the cache', async () => {
    const verify = vi.fn(only('good'))
    const gate = createTokenGate({ verify })

    expect(await gate.allow('good')).toBe(true)
    expect(await gate.allow('good')).toBe(true)
    expect(await gate.allow('good')).toBe(true)
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('collapses a reconnect storm into one check', async () => {
    const verify = vi.fn(only('good'))
    const gate = createTokenGate({ verify })

    const verdicts = await Promise.all(Array.from({ length: 10 }, () => gate.allow('good')))

    expect(verdicts.every(Boolean)).toBe(true)
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('re-verifies once the cache window has passed', async () => {
    const verify = vi.fn(only('good'))
    const time = clock()
    const gate = createTokenGate({ verify, ttlMs: 60_000, now: time.now })

    expect(await gate.allow('good')).toBe(true)
    time.advance(59_000)
    expect(await gate.allow('good')).toBe(true)
    expect(verify).toHaveBeenCalledTimes(1)

    time.advance(2_000)
    expect(await gate.allow('good')).toBe(true)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('caches a refusal too, and keeps tokens apart', async () => {
    const verify = vi.fn(only('good'))
    const gate = createTokenGate({ verify })

    expect(await gate.allow('stale')).toBe(false)
    expect(await gate.allow('stale')).toBe(false)
    expect(await gate.allow('good')).toBe(true)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('refuses a missing or empty token without asking anyone', async () => {
    const verify = vi.fn(only('good'))
    const gate = createTokenGate({ verify })

    expect(await gate.allow(null)).toBe(false)
    expect(await gate.allow(undefined)).toBe(false)
    expect(await gate.allow('')).toBe(false)
    expect(verify).not.toHaveBeenCalled()
  })

  it('does not remember a check that failed to run', async () => {
    const verify = vi
      .fn<VerifyToken>()
      .mockRejectedValueOnce(new Error('auth check unavailable (503)'))
      .mockResolvedValue(true)
    const gate = createTokenGate({ verify })

    await expect(gate.allow('good')).rejects.toThrow('unavailable')
    expect(await gate.allow('good')).toBe(true)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('lets everything through when auth is off', async () => {
    expect(await openGate.allow(null)).toBe(true)
    expect(await createGate({ mode: 'off' }).allow(null)).toBe(true)
  })

  it('builds a verifying gate from an on config without touching the network', async () => {
    const verify = vi.fn(only('good'))
    const gate = createGate(
      { mode: 'on', filename: '/private/manor.db', ownerUserId: '11111111-1111-4111-8111-111111111111' },
      { verify },
    )

    expect(await gate.allow('good')).toBe(true)
    expect(await gate.allow(null)).toBe(false)
  })

  it('refuses to build an on gate without a verifier, rather than letting everyone in', () => {
    expect(() => createGate({ mode: 'on', filename: '/private/manor.db', ownerUserId: 'x' })).toThrow('verifier')
  })
})

describe('upgrade guard', () => {
  const request = (url: string | undefined, origin?: string, host = 'localhost:8787') => ({
    url,
    headers: { ...(origin === undefined ? {} : { origin }), host },
  })
  const guardWith = (gate = createTokenGate({ verify: only('good') })) =>
    createUpgradeGuard({ path: '/ws', gate, allowedOrigins: ['http://localhost:5173'] })

  it('refuses an upgrade that carries no token', async () => {
    expect(await guardWith()(request('/ws'))).toEqual({
      ok: false,
      status: 401,
      reason: 'missing or rejected token',
    })
  })

  it('refuses a token the verifier does not know', async () => {
    const verdict = await guardWith()(request('/ws?token=stale'))

    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('expected a refusal')
    expect(verdict.status).toBe(401)
  })

  it('accepts a verified token', async () => {
    expect(await guardWith()(request('/ws?token=good'))).toEqual({ ok: true })
  })

  it('accepts anything on the right path when auth is off', async () => {
    const guard = createUpgradeGuard({ path: '/ws', gate: openGate, allowedOrigins: [] })

    expect(await guard(request('/ws'))).toEqual({ ok: true })
  })

  it('accepts the serving origin and the configured Vite origin', async () => {
    const guard = guardWith(openGate)

    expect(await guard(request('/ws', 'http://localhost:8787'))).toEqual({ ok: true })
    expect(await guard(request('/ws', 'http://localhost:5173'))).toEqual({ ok: true })
  })

  it('refuses a browser origin outside the allowlist before checking its token', async () => {
    const gate = { allow: vi.fn(() => Promise.resolve(true)) }
    const guard = guardWith(gate)

    expect(await guard(request('/ws?token=good', 'https://hostile.example'))).toEqual({
      ok: false,
      status: 401,
      reason: 'origin not allowed',
    })
    expect(gate.allow).not.toHaveBeenCalled()
  })

  it('keeps non-browser clients possible when they still pass the auth gate', async () => {
    expect(await guardWith()(request('/ws?token=good'))).toEqual({ ok: true })
  })

  it('sends anything off the socket path away as 404, token or not', async () => {
    const guard = createUpgradeGuard({ path: '/ws', gate: openGate, allowedOrigins: [] })

    expect(await guard(request('/'))).toEqual({ ok: false, status: 404, reason: 'unknown path' })
    expect(await guard(request(undefined))).toEqual({ ok: false, status: 404, reason: 'unknown path' })
    expect((await guard(request('/admin?token=good'))).ok).toBe(false)
  })
})

describe('rejectUpgrade', () => {
  it('answers in HTTP and hangs up, leaving no half-open connection', () => {
    const fake = fakeSocket()

    rejectUpgrade(fake.socket, 401)

    expect(fake.written.join('')).toContain('HTTP/1.1 401 Unauthorized')
    expect(fake.written.join('')).toContain('Connection: close')
    expect(fake.isDestroyed()).toBe(true)
  })

  it('says 404 when that is the verdict', () => {
    const fake = fakeSocket()

    rejectUpgrade(fake.socket, 404)

    expect(fake.written.join('')).toContain('HTTP/1.1 404 Not Found')
    expect(fake.isDestroyed()).toBe(true)
  })
})
