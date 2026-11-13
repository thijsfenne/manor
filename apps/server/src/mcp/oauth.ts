import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { chmodSync } from 'node:fs'

/**
 * MCP OAuth for HTTP servers (Figma first). Tokens live on the machine under
 * ~/.manor/mcp-oauth, never in the registry. A 401 starts a browser login; Test
 * again after the callback writes the file.
 */

const execFileAsync = promisify(execFile)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const mcpBearerEnvKey = (serverName: string): string =>
  `MANOR_MCP_BEARER_${serverName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`

/**
 * Figma's DCR allowlist is a string match on `client_name`. "Claude Code" returns
 * 201 and a fresh client_id; "Manor" returns 403. We register our own client, we
 * do not reuse Cursor's. The name is the CLI that will present the token on a
 * Claude turn. Grok is not on that list and must not borrow this login.
 */
export const FIGMA_OAUTH_CLIENT_NAME = 'Claude Code'

export interface McpOAuthTokens {
  resource: string
  clientId: string
  clientSecret: string
  tokenEndpoint: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface PendingLogin {
  resource: string
  verifier: string
  state: string
  redirectUri: string
  clientId: string
  clientSecret: string
  tokenEndpoint: string
  /** Closes this attempt's callback listener and forgets it, reporting how it ended. Idempotent. */
  cleanup: (result?: McpOAuthResult) => void
  /** Who hears the outcome; a replacing attempt takes them over. */
  listeners: ((result: McpOAuthResult) => void)[]
  /** Ends the wait for the browser; stopped once the callback is accepted. */
  expiry: ReturnType<typeof setTimeout>
}

/** How one browser login ended, for a connect card that follows it. */
export type McpOAuthResult = { status: 'connected' } | { status: 'failed'; reason: string }

const pending = new Map<string, PendingLogin>()

/** How long a browser login may stay unfinished before its callback listener closes. */
export const MCP_OAUTH_LOGIN_LIFETIME_MS = 10 * 60_000

/** Deadline for each discovery, registration and token request. */
const OAUTH_FETCH_TIMEOUT_MS = 15_000

/** Logins still waiting for their browser callback. */
export const pendingMcpOAuthLogins = (): number => pending.size

export const oauthDir = (home: string = homedir()): string => path.join(home, '.manor', 'mcp-oauth')

const tokenPath = (resource: string, home?: string): string => {
  const hash = createHash('sha256').update(resource).digest('hex').slice(0, 16)
  return path.join(oauthDir(home), `${hash}.json`)
}

export async function readMcpOAuthTokens(resource: string, home?: string): Promise<McpOAuthTokens | undefined> {
  try {
    const raw = JSON.parse(await readFile(tokenPath(resource, home), 'utf8')) as unknown
    if (!isRecord(raw) || typeof raw['accessToken'] !== 'string') return undefined
    return raw as unknown as McpOAuthTokens
  } catch {
    return undefined
  }
}

export async function writeMcpOAuthTokens(tokens: McpOAuthTokens, home?: string): Promise<void> {
  const dir = oauthDir(home)
  await mkdir(dir, { recursive: true })
  const file = tokenPath(tokens.resource, home)
  await writeFile(file, JSON.stringify(tokens), 'utf8')
  chmodSync(file, 0o600)
}

export async function accessTokenFor(resource: string, home?: string): Promise<string | undefined> {
  const stored = await readMcpOAuthTokens(resource, home)
  if (stored === undefined) return undefined
  if (stored.expiresAt > Date.now() + 30_000) return stored.accessToken
  const refreshed = await refreshMcpOAuth(stored, home)
  return refreshed?.accessToken
}

async function refreshMcpOAuth(stored: McpOAuthTokens, home?: string): Promise<McpOAuthTokens | undefined> {
  if (stored.refreshToken.length === 0) return undefined
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    client_id: stored.clientId,
    client_secret: stored.clientSecret,
    resource: stored.resource,
  })
  const response = await fetch(stored.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const json = (await response.json()) as Record<string, unknown>
  if (typeof json['access_token'] !== 'string') return undefined
  const next: McpOAuthTokens = {
    ...stored,
    accessToken: json['access_token'],
    refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : stored.refreshToken,
    expiresAt: Date.now() + (typeof json['expires_in'] === 'number' ? json['expires_in'] * 1000 : 3_600_000),
  }
  await writeMcpOAuthTokens(next, home)
  return next
}

export function isOauthRequired(error: unknown): boolean {
  return error instanceof Error && error.message.includes('requires OAuth (HTTP 401)')
}

export async function openLoginBrowser(url: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('MCP login needs a Mac browser.')
  }
  await execFileAsync('/usr/bin/open', [url])
}

/**
 * Starts a loopback callback and opens the system browser. Returns once the window
 * is open. The token file is written when the login lands, not before.
 */
export async function beginMcpOAuth(
  resource: string,
  options: {
    open?: (url: string) => Promise<void>
    home?: string
    clientName?: string
    /** Defaults to MCP_OAUTH_LOGIN_LIFETIME_MS. */
    lifetimeMs?: number
    /**
     * Called once when the login lands, is refused, expires or fails to start. A retry
     * (a card's or Settings Test's) takes the listener over instead of ending it.
     */
    onResult?: (result: McpOAuthResult) => void
  } = {},
): Promise<{ authorizationUrl: string }> {
  const metadata = await discover(resource)
  const redirect = await listenForCallback(options.home)
  // From here to `pending.set` nothing awaits, so of two overlapping starts the later one
  // always replaces the earlier and inherits who waits on it.
  const listeners = options.onResult === undefined ? [] : [options.onResult]
  for (const login of [...pending.values()]) {
    if (login.resource !== resource) continue
    listeners.push(...login.listeners)
    login.cleanup()
  }
  const state = base64url(randomBytes(16))
  let cleaned = false
  let superseded = false
  const cleanup = (result?: McpOAuthResult) => {
    if (cleaned) return
    cleaned = true
    // Only a replacing start ends an attempt without an outcome.
    superseded = result === undefined
    clearTimeout(expiry)
    pending.delete(state)
    redirect.server.close()
    if (result !== undefined) for (const listener of listeners) listener(result)
  }
  const expiry = setTimeout(
    () => cleanup({ status: 'failed', reason: 'The sign-in was not finished in time.' }),
    options.lifetimeMs ?? MCP_OAUTH_LOGIN_LIFETIME_MS,
  )
  expiry.unref()
  const verifier = base64url(randomBytes(32))
  // Reserved before registration; the browser learns `state` only after it, so no callback can match early.
  const login: PendingLogin = {
    resource, verifier, state, redirectUri: redirect.redirectUri,
    clientId: '', clientSecret: '', tokenEndpoint: metadata.tokenEndpoint, cleanup, listeners, expiry,
  }
  pending.set(state, login)
  try {
    const client = await registerClient(
      metadata.registrationEndpoint,
      redirect.redirectUri,
      options.clientName ?? FIGMA_OAUTH_CLIENT_NAME,
    )
    // A newer start took over while this one registered; it owns the browser and the outcome.
    if (superseded) return { authorizationUrl: '' }
    login.clientId = client.clientId
    login.clientSecret = client.clientSecret
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const authorizationUrl = new URL(metadata.authorizationEndpoint)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', client.clientId)
    authorizationUrl.searchParams.set('redirect_uri', redirect.redirectUri)
    authorizationUrl.searchParams.set('scope', 'mcp:connect')
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('code_challenge', challenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    authorizationUrl.searchParams.set('resource', resource)
    const open = options.open ?? openLoginBrowser
    await open(authorizationUrl.href)
    return { authorizationUrl: authorizationUrl.href }
  } catch (error: unknown) {
    if (superseded) return { authorizationUrl: '' }
    // A fixed reason: the open command's own error quotes the authorisation URL.
    cleanup({ status: 'failed', reason: 'The sign-in did not start.' })
    throw error
  }
}

async function discover(resource: string): Promise<{
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
}> {
  const wellKnown = new URL('/.well-known/oauth-protected-resource', resource)
  // Figma's metadata lives on the host root, not under /mcp.
  wellKnown.pathname = '/.well-known/oauth-protected-resource'
  const resourceDoc = await fetchJson(wellKnown.href)
  const servers = resourceDoc['authorization_servers']
  const issuer = Array.isArray(servers) && typeof servers[0] === 'string' ? servers[0] : undefined
  if (issuer === undefined) throw new Error(`${resource} did not name an authorization server.`)
  const asWellKnown = issuer.endsWith('/')
    ? `${issuer}.well-known/oauth-authorization-server`
    : `${issuer}/.well-known/oauth-authorization-server`
  const as = await fetchJson(asWellKnown)
  const authorizationEndpoint = stringField(as, 'authorization_endpoint')
  const tokenEndpoint = stringField(as, 'token_endpoint')
  const registrationEndpoint = stringField(as, 'registration_endpoint')
  if (!authorizationEndpoint || !tokenEndpoint || !registrationEndpoint) {
    throw new Error(`${resource} OAuth metadata is incomplete.`)
  }
  return { authorizationEndpoint, tokenEndpoint, registrationEndpoint }
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  })
  if (response.status === 403) {
    throw new Error(
      `Figma refused the client name ${clientName}. Remote Figma login only works for listed runtimes.`,
    )
  }
  if (!response.ok) throw new Error(`OAuth client registration failed (${response.status}).`)
  const json = await response.json()
  if (!isRecord(json) || typeof json['client_id'] !== 'string') {
    throw new Error('OAuth client registration returned no client_id.')
  }
  return {
    clientId: json['client_id'],
    clientSecret: typeof json['client_secret'] === 'string' ? json['client_secret'] : '',
  }
}

async function listenForCallback(home?: string): Promise<{ redirectUri: string; server: ReturnType<typeof createServer> }> {
  const server = createServer((request, response) => {
    handleCallback(request, response, home).catch(() => response.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('could not bind the OAuth callback port')
  }
  return { redirectUri: `http://127.0.0.1:${address.port}/callback`, server }
}

async function handleCallback(request: IncomingMessage, response: ServerResponse, home?: string): Promise<void> {
  let url: URL
  try {
    url = new URL(request.url ?? '/', 'http://127.0.0.1')
  } catch {
    // A malformed target is not the callback; the login stays open for the real one.
    response.writeHead(400)
    response.end()
    return
  }
  const html = (body: string) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Manor</title><p>${body}</p>`)
  }
  if (url.pathname !== '/callback') {
    response.writeHead(404)
    response.end()
    return
  }
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const login = pending.get(state)
  if (login === undefined) {
    html('That login did not match an open Manor request.')
    return
  }
  if (code.length === 0) {
    // A matching state without a code is the provider's answer to a cancelled or
    // refused consent (`error=access_denied`); the attempt is over, not still open.
    login.cleanup({ status: 'failed', reason: 'The sign-in was cancelled.' })
    html('The login was cancelled. Close this window and retry from Manor.')
    return
  }
  pending.delete(state)
  // The browser answered; a slow token exchange must not be overtaken by the expiry.
  clearTimeout(login.expiry)
  let result: McpOAuthResult = { status: 'failed', reason: 'The provider did not accept the sign-in.' }
  try {
    const tokens = await exchangeCode(login, code)
    await writeMcpOAuthTokens(tokens, home)
    result = { status: 'connected' }
    html('Manor is signed in. You can close this window and go back to Manor.')
  } catch {
    html('Figma login failed. Close this window and retry from Manor.')
  } finally {
    login.cleanup(result)
  }
}

async function exchangeCode(login: PendingLogin, code: string): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: login.redirectUri,
    client_id: login.clientId,
    code_verifier: login.verifier,
    resource: login.resource,
  })
  if (login.clientSecret.length > 0) body.set('client_secret', login.clientSecret)
  const response = await fetch(login.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`token exchange failed (${response.status})`)
  const json = (await response.json()) as Record<string, unknown>
  if (typeof json['access_token'] !== 'string') throw new Error('token exchange returned no access_token')
  return {
    resource: login.resource,
    clientId: login.clientId,
    clientSecret: login.clientSecret,
    tokenEndpoint: login.tokenEndpoint,
    accessToken: json['access_token'],
    refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : '',
    expiresAt: Date.now() + (typeof json['expires_in'] === 'number' ? json['expires_in'] * 1000 : 3_600_000),
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`could not load ${url}`)
  const json: unknown = await response.json()
  if (!isRecord(json)) throw new Error(`could not load ${url}`)
  return json
}

const stringField = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined

const base64url = (bytes: Buffer): string =>
  bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
