import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { probeMcpServer } from '../src/mcp/probe.js'

const draft = (url: string) => ({
  name: 'figma',
  command: '',
  args: [] as string[],
  envKeys: [] as string[],
  url,
  description: '',
  writes: false,
  effectPolicy: 'confirm_writes' as const,
})

const listen = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

describe('probeMcpServer, HTTP', () => {
  it('lists tools from a JSON streamable HTTP server', async () => {
    const hosted = await listen(async (request, response) => {
      const payload = JSON.parse(await readBody(request)) as { id?: number; method?: string }
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Mcp-Session-Id', 's1')
      if (payload.method === 'initialize') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18', capabilities: {}, instructions: 'Use Figma.' } }))
        return
      }
      if (payload.method === 'tools/list') {
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              tools: [
                { name: 'get_design_context', description: 'Design context', inputSchema: { type: 'object' } },
                { name: 'get_screenshot', description: 'Screenshot', inputSchema: { type: 'object' } },
              ],
            },
          }),
        )
        return
      }
      response.statusCode = 204
      response.end()
    })
    try {
      const result = await probeMcpServer(draft(hosted.url))
      expect(result.tools).toEqual(['get_design_context', 'get_screenshot'])
      expect(result.readOnlyTools).toEqual(['get_design_context', 'get_screenshot'])
      expect(result.schemaChars).toBeGreaterThan(JSON.stringify('Use Figma.').length)
    } finally {
      await hosted.close()
    }
  })

  it('resolves declared HTTP headers from the host environment', async () => {
    const seen: Array<string | undefined> = []
    const hosted = await listen(async (request, response) => {
      seen.push(request.headers['x-consumer-api-key'] as string | undefined)
      const payload = JSON.parse(await readBody(request)) as { id?: number; method?: string }
      response.setHeader('Content-Type', 'application/json')
      if (payload.method === 'initialize') {
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: { protocolVersion: '2025-06-18', capabilities: {} },
        }))
        return
      }
      if (payload.method === 'tools/list') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: [] } }))
        return
      }
      response.statusCode = 202
      response.end()
    })
    try {
      await probeMcpServer({
        ...draft(hosted.url),
        httpHeaders: [{ name: 'x-consumer-api-key', envKey: 'COMPOSIO_CONSUMER_API_KEY' }],
      }, { env: { COMPOSIO_CONSUMER_API_KEY: 'ck_test' } })
      expect(seen).toContain('ck_test')
    } finally {
      await hosted.close()
    }
  })

  it('refuses an HTTP header whose environment value is missing', async () => {
    await expect(probeMcpServer({
      ...draft('http://127.0.0.1:1/mcp'),
      httpHeaders: [{ name: 'x-consumer-api-key', envKey: 'COMPOSIO_CONSUMER_API_KEY' }],
    }, { env: {} })).rejects.toThrow(/COMPOSIO_CONSUMER_API_KEY/)
  })

  it('skips an SSE notification on a CRLF stream and reads the JSON-RPC response with the matching id', async () => {
    const hosted = await listen(async (request, response) => {
      const payload = JSON.parse(await readBody(request)) as { id?: number; method?: string }
      if (payload.method === 'initialize') {
        response.setHeader('Content-Type', 'application/json')
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
        response.setHeader('Content-Type', 'text/event-stream')
        const notify = JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progress: 1 },
        })
        const reply = JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: { tools: [{ name: 'get_metadata', description: 'Meta', inputSchema: {} }] },
        })
        response.end(`event: message\r\ndata: ${notify}\r\n\r\nevent: message\r\ndata: ${reply}\r\n\r\n`)
        return
      }
      response.statusCode = 202
      response.end()
    })
    try {
      const result = await probeMcpServer(draft(hosted.url))
      expect(result.tools).toEqual(['get_metadata'])
    } finally {
      await hosted.close()
    }
  })

  it('resolves as soon as the SSE result arrives while the server keeps the stream open', async () => {
    const open: ServerResponse[] = []
    const hosted = await listen(async (request, response) => {
      const payload = JSON.parse(await readBody(request)) as { id?: number; method?: string }
      if (payload.id === undefined) {
        response.statusCode = 202
        response.end()
        return
      }
      const result = payload.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {} }
        : { tools: [{ name: 'get_metadata', description: 'Meta', inputSchema: {} }] }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result })}\n\n`)
      open.push(response)
    })
    try {
      const started = Date.now()
      const result = await probeMcpServer(draft(hosted.url), { timeoutMs: 5_000 })
      expect(result.tools).toEqual(['get_metadata'])
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      for (const response of open) response.end()
      await hosted.close()
    }
  })

  it('says the URL could not be reached when nothing is listening', async () => {
    await expect(probeMcpServer(draft('http://127.0.0.1:1/mcp'), { timeoutMs: 500 })).rejects.toThrow(
      /could not reach http:\/\/127\.0\.0\.1:1\/mcp/,
    )
  })

  it('names a 401 as OAuth required rather than a missing MCP handshake', async () => {
    const hosted = await listen((_request, response) => {
      response.statusCode = 401
      response.setHeader('WWW-Authenticate', 'Bearer realm="mcp"')
      response.end('Unauthorized')
    })
    try {
      await expect(probeMcpServer(draft(hosted.url))).rejects.toThrow(/requires OAuth \(HTTP 401\)/)
    } finally {
      await hosted.close()
    }
  })

  it('refuses a URL that answers 204 instead of MCP', async () => {
    const hosted = await listen((_request, response) => {
      response.statusCode = 204
      response.end()
    })
    try {
      await expect(probeMcpServer(draft(hosted.url))).rejects.toThrow(/did not speak MCP/)
    } finally {
      await hosted.close()
    }
  })

  it('sends the negotiated protocol version after initialize, including on initialized', async () => {
    const seen: { method: string; protocol?: string }[] = []
    const hosted = await listen(async (request, response) => {
      const payload = JSON.parse(await readBody(request)) as { id?: number; method?: string }
      seen.push({
        method: payload.method ?? '',
        protocol: request.headers['mcp-protocol-version'] as string | undefined,
      })
      response.setHeader('Content-Type', 'application/json')
      if (payload.method === 'initialize') {
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: { protocolVersion: '2025-03-26', capabilities: {} },
          }),
        )
        return
      }
      if (payload.method === 'tools/list') {
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: { tools: [{ name: 'whoami', description: 'id', inputSchema: {} }] },
          }),
        )
        return
      }
      response.statusCode = 202
      response.end()
    })
    try {
      await probeMcpServer(draft(hosted.url))
      expect(seen.find((entry) => entry.method === 'initialize')?.protocol).toBeUndefined()
      expect(seen.find((entry) => entry.method === 'notifications/initialized')?.protocol).toBe('2025-03-26')
      expect(seen.find((entry) => entry.method === 'tools/list')?.protocol).toBe('2025-03-26')
    } finally {
      await hosted.close()
    }
  })
})
