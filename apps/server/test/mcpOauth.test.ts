import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { connect } from 'node:net'
import {
  beginMcpOAuth,
  FIGMA_OAUTH_CLIENT_NAME,
  mcpBearerEnvKey,
  pendingMcpOAuthLogins,
  readMcpOAuthTokens,
  writeMcpOAuthTokens,
} from '../src/mcp/oauth.js'
import { probeHttpMcpServer } from '../src/mcp/httpProbe.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

describe('mcpBearerEnvKey', () => {
  it('is a safe environment name', () => {
    expect(mcpBearerEnvKey('figma')).toBe('MANOR_MCP_BEARER_FIGMA')
    expect(mcpBearerEnvKey('mail-other')).toBe('MANOR_MCP_BEARER_MAIL_OTHER')
  })
})

describe('Figma OAuth client name', () => {
  it('is the listed Claude Code string, not Manor', () => {
    expect(FIGMA_OAUTH_CLIENT_NAME).toBe('Claude Code')
  })
})

describe('mcp oauth token file', () => {
  it('round-trips a token and does not throw on a missing file', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'manor-oauth-'))
    expect(await readMcpOAuthTokens('https://mcp.figma.com/mcp', home)).toBeUndefined()
    await writeMcpOAuthTokens(
      {
        resource: 'https://mcp.figma.com/mcp',
        clientId: 'c',
        clientSecret: 's',
        tokenEndpoint: 'https://example.com/token',
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: Date.now() + 60_000,
      },
      home,
    )
    const stored = await readMcpOAuthTokens('https://mcp.figma.com/mcp', home)
    expect(stored?.accessToken).toBe('tok')
  })
})

describe('probeHttpMcpServer bearer', () => {
  it('sends Authorization when a bearer is provided', async () => {
    const seen: string[] = []
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      seen.push(request.headers.authorization ?? '')
      response.setHeader('Content-Type', 'application/json')
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string }
        if (payload.method === 'initialize') {
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: { protocolVersion: '2025-06-18', capabilities: {} },
            }),
          )
          return
        }
        if (payload.method === 'tools/list') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: [] } }))
          return
        }
        response.statusCode = 202
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    try {
      await probeHttpMcpServer(
        {
          name: 'figma',
          command: '',
          args: [],
          envKeys: [],
          url: `http://127.0.0.1:${address.port}/mcp`,
          description: '',
          writes: true,
          effectPolicy: 'confirm_writes' as const,
        },
        { bearer: 'tok_live' },
      )
      expect(seen.some((header) => header === 'Bearer tok_live')).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
})

describe('beginMcpOAuth attempt lifecycle', () => {
  /**
   * A local authorization server; registration answers with `registerStatus` once
   * `registerTogether` registrations arrived, so overlapping starts overlap by construction.
   */
  const authServer = async (registerStatus: number, registerTogether = 1) => {
    const registered: string[] = []
    const held: ServerResponse[] = []
    const server = createServer((request, response) => {
      const base = `http://127.0.0.1:${port}`
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/.well-known/oauth-protected-resource') {
        response.end(JSON.stringify({ authorization_servers: [base] }))
      } else if (request.url === '/.well-known/oauth-authorization-server') {
        response.end(JSON.stringify({
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
        }))
      } else if (request.url === '/register') {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { redirect_uris: string[] }
          registered.push(...body.redirect_uris)
          held.push(response)
          if (held.length < registerTogether) return
          for (const waiting of held.splice(0)) {
            waiting.statusCode = registerStatus
            waiting.end(registerStatus === 201 ? JSON.stringify({ client_id: 'c1' }) : '{}')
          }
        })
      } else {
        response.statusCode = 404
        response.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const port = address.port
    return {
      registered,
      resource: `http://127.0.0.1:${port}/mcp`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  const redirectOf = (authorizationUrl: string) =>
    new URL(new URL(authorizationUrl).searchParams.get('redirect_uri') ?? '')

  const refuses = async (redirect: URL) => {
    await expect(fetch(redirect.href)).rejects.toThrow()
  }

  it('closes the callback listener and keeps nothing pending when registration fails', async () => {
    const as = await authServer(500)
    const before = pendingMcpOAuthLogins()
    try {
      await expect(beginMcpOAuth(as.resource, { open: async () => undefined }))
        .rejects.toThrow(/registration failed \(500\)/)
    } finally {
      await as.close()
    }
    expect(as.registered).toHaveLength(1)
    await refuses(new URL(as.registered[0]!))
    expect(pendingMcpOAuthLogins()).toBe(before)
  })

  it('answers a malformed callback target with 400 and keeps the login open', async () => {
    const as = await authServer(201)
    try {
      // A lifetime the test outlives by far; it ends the login itself below.
      const { authorizationUrl } = await beginMcpOAuth(as.resource, { open: async () => undefined, lifetimeMs: 60_000 })
      const redirect = redirectOf(authorizationUrl)
      const status = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(redirect.port), '127.0.0.1', () => {
          socket.write('GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
        })
        let raw = ''
        socket.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
        socket.on('end', () => resolve(raw.split('\r\n')[0] ?? ''))
        socket.on('error', reject)
      })
      expect(status).toBe('HTTP/1.1 400 Bad Request')
      const stillOpen = await fetch(new URL('/callback?state=nope&code=x', redirect).href)
      expect(await stillOpen.text()).toContain('did not match')
      // Ended here, so no later test counts it as pending.
      const state = new URL(authorizationUrl).searchParams.get('state')
      await fetch(new URL(`/callback?state=${state}&error=access_denied`, redirect).href)
    } finally {
      await as.close()
    }
  })

  it('ends the attempt when the user cancels consent at the provider', async () => {
    const as = await authServer(201)
    const before = pendingMcpOAuthLogins()
    try {
      const results: unknown[] = []
      const { authorizationUrl } = await beginMcpOAuth(as.resource, {
        open: async () => undefined, lifetimeMs: 60_000, onResult: (result) => results.push(result),
      })
      const state = new URL(authorizationUrl).searchParams.get('state') ?? ''
      const redirect = redirectOf(authorizationUrl)
      const answer = await fetch(new URL(`/callback?state=${state}&error=access_denied`, redirect).href)
      expect(await answer.text()).toContain('cancelled')
      expect(pendingMcpOAuthLogins()).toBe(before)
      // A connect card hears how the login ended, once.
      expect(results).toEqual([{ status: 'failed', reason: 'The sign-in was cancelled.' }])
      await refuses(redirect)
    } finally {
      await as.close()
    }
  })

  it('keeps one live login when two starts overlap during registration', async () => {
    const as = await authServer(201, 2)
    const before = pendingMcpOAuthLogins()
    const opened: string[] = []
    const results: unknown[] = []
    try {
      const options = { open: async (url: string) => { opened.push(url) }, lifetimeMs: 60_000, onResult: (result: unknown) => results.push(result) }
      const [first, second] = await Promise.all([beginMcpOAuth(as.resource, options), beginMcpOAuth(as.resource, options)])
      // The superseded start opens nothing and reports nothing; the newer one owns both.
      expect([first.authorizationUrl, second.authorizationUrl].filter((url) => url.length > 0)).toHaveLength(1)
      expect(opened).toHaveLength(1)
      expect(pendingMcpOAuthLogins()).toBe(before + 1)
      expect(results).toEqual([])
      const live = new URL(opened[0]!)
      await fetch(new URL(`/callback?state=${live.searchParams.get('state')}&error=access_denied`, redirectOf(opened[0]!)).href)
      expect(results).toHaveLength(2)
    } finally {
      await as.close()
    }
  })

  it('replaces an unfinished login for the same server and expires one the user never finishes', async () => {
    const as = await authServer(201)
    const before = pendingMcpOAuthLogins()
    // The expiry runs on fake time: on a loaded machine a real 100ms lifetime ran out mid-test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const results: unknown[] = []
      const first = await beginMcpOAuth(as.resource, { open: async () => undefined, lifetimeMs: 60_000, onResult: (result) => results.push(result) })
      const second = await beginMcpOAuth(as.resource, { open: async () => undefined, lifetimeMs: 100, onResult: (result) => results.push(result) })
      await refuses(redirectOf(first.authorizationUrl))
      expect(pendingMcpOAuthLogins()).toBe(before + 1)
      expect(results).toEqual([])
      await vi.advanceTimersByTimeAsync(100)
      await refuses(redirectOf(second.authorizationUrl))
      expect(pendingMcpOAuthLogins()).toBe(before)
      // The replacement took the first listener over, so both hear the one real ending.
      expect(results).toEqual([
        { status: 'failed', reason: 'The sign-in was not finished in time.' },
        { status: 'failed', reason: 'The sign-in was not finished in time.' },
      ])
    } finally {
      vi.useRealTimers()
      await as.close()
    }
  })
})
