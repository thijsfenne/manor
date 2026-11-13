import type { AuthConfig } from './config.js'

/**
 * The one seam this file exists for. Same shape as the drivers' `SpawnFn`: a
 * single function, real in production, faked in tests, so nothing here needs a
 * network to be provable.
 */
export type VerifyToken = (token: string) => Promise<boolean>

/** How long one verdict is trusted by default. `createGate` passes 0: a LocalAuth check is a local lookup. */
export const TOKEN_CACHE_TTL_MS = 60_000

export interface TokenGate {
  /** True when this connection may proceed. A missing token is never allowed. */
  allow(token: string | null | undefined): Promise<boolean>
}

export interface TokenGateOptions {
  verify: VerifyToken
  ttlMs?: number
  now?: () => number
}

/**
 * Verifies tokens, briefly remembering the answer per token. With a positive TTL
 * the cache holds the in-flight promise, so ten sockets arriving together produce
 * one call, not ten. A thrown check is never cached.
 */
export function createTokenGate(options: TokenGateOptions): TokenGate {
  const ttlMs = options.ttlMs ?? TOKEN_CACHE_TTL_MS
  const now = options.now ?? Date.now
  const cache = new Map<string, { verdict: Promise<boolean>; expires: number }>()

  return {
    async allow(token) {
      if (typeof token !== 'string' || token.length === 0) return false
      const at = now()
      for (const [key, entry] of cache) {
        if (entry.expires <= at) cache.delete(key)
      }
      const hit = cache.get(token)
      if (hit !== undefined) return hit.verdict

      const verdict = options.verify(token)
      cache.set(token, { verdict, expires: at + ttlMs })
      // A thrown check is not an answer; drop it so the next connection retries.
      verdict.catch(() => cache.delete(token))
      return verdict
    },
  }
}

/** The `MANOR_AUTH=off` gate: everything in, nothing verified. */
export const openGate: TokenGate = { allow: () => Promise.resolve(true) }

/** The one place an auth config becomes a gate. */
export function createGate(config: AuthConfig, overrides: Partial<TokenGateOptions> = {}): TokenGate {
  if (config.mode === 'off') return openGate
  if (overrides.verify === undefined) throw new Error('Auth requires the local session verifier')
  // Revoking a device session must take effect on the next connection, so no verdict is cached.
  return createTokenGate({ ...overrides, verify: overrides.verify, ttlMs: 0 })
}

export type UpgradeVerdict = { ok: true } | { ok: false; status: 401 | 404; reason: string }

export interface UpgradeRequest {
  url?: string
  headers: { origin?: string; host?: string }
}

/**
 * Decides whether one HTTP upgrade may become a socket, before `ws` ever sees it.
 * The token rides in the query string because a browser WebSocket cannot set
 * headers; nothing in this server logs a request URL, and nothing should start.
 */
export function createUpgradeGuard(options: { path: string; gate: TokenGate; allowedOrigins: readonly string[] }) {
  const allowedOrigins = new Set(options.allowedOrigins)
  return async (request: UpgradeRequest): Promise<UpgradeVerdict> => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://manor.invalid')
    } catch {
      return { ok: false, status: 404, reason: 'unparseable request target' }
    }
    if (url.pathname !== options.path) return { ok: false, status: 404, reason: 'unknown path' }

    const origin = request.headers.origin
    if (origin !== undefined) {
      let parsed: URL
      try {
        parsed = new URL(origin)
      } catch {
        return { ok: false, status: 401, reason: 'origin not allowed' }
      }
      const sameOrigin = request.headers.host !== undefined && parsed.host === request.headers.host
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || (!sameOrigin && !allowedOrigins.has(parsed.origin))) {
        return { ok: false, status: 401, reason: 'origin not allowed' }
      }
    }

    const allowed = await options.gate.allow(url.searchParams.get('token'))
    return allowed ? { ok: true } : { ok: false, status: 401, reason: 'missing or rejected token' }
  }
}

/** The bits of a raw upgrade socket a refusal touches; narrow so tests can fake it. */
export interface UpgradeSocket {
  write(data: string): unknown
  destroy(): void
}

/** Says no in HTTP and hangs up, rather than leaving a half-open connection. */
export function rejectUpgrade(socket: UpgradeSocket, status: 401 | 404): void {
  const text = status === 401 ? 'Unauthorized' : 'Not Found'
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}
