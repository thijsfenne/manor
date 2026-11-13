import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POSTED_ASK_NOTE, interactionMcpServer } from '../src/mcp/interactionServer.js'

const questions = [{ id: 'direction', question: 'Which direction?', options: [{ label: 'A' }, { label: 'B' }] }]

async function broker(onRequest: (body: Record<string, unknown>, response: ServerResponse<IncomingMessage>) => void) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => onRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>, response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const url = `http://127.0.0.1:${port}/internal/user-input`
  const argv = ['--broker-url', url, '--draft-url', url, '--relay-url', url, '--subagent-url', url,
    '--deliver-url', url, '--goal-url', url, '--secret-url', 'http://127.0.0.1:1/internal/secret-request', '--project-url', url, '--tool', 'ask_user']
  return { server, argv }
}

describe('ask_user transport', () => {
  afterEach(() => { vi.useRealTimers() })

  // Global fetch gave up on headers at 300 s, so every question still open at five
  // minutes came back to Claude as "fetch failed" and its answer reached nobody.
  it('still delivers an answer given after more than five minutes', async () => {
    let reply: ((answers: Record<string, string>) => void) | undefined
    const { server, argv } = await broker((_body, response) => {
      reply = (answers) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ answers }))
      }
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
    try {
      const call = interactionMcpServer(argv).callTool('ask_user', { questions }, 'capability')
      await vi.waitFor(() => expect(reply).toBeDefined())
      for (let second = 0; second < 6 * 60 + 10; second += 1) await vi.advanceTimersByTimeAsync(1000)
      reply!({ direction: 'B' })

      await expect(call).resolves.toEqual([{ type: 'text', text: JSON.stringify({ answers: { direction: 'B' } }) }])
    } finally {
      server.close()
    }
  }, 30_000)

  it('posts the question and returns at once in deferred mode', async () => {
    const bodies: Record<string, unknown>[] = []
    const { server, argv } = await broker((body, response) => {
      bodies.push(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ posted: true }))
    })
    try {
      const server_ = interactionMcpServer([...argv, '--ask-mode', 'deferred'])
      await expect(server_.callTool('ask_user', { questions }, 'capability'))
        .resolves.toEqual([{ type: 'text', text: POSTED_ASK_NOTE }])
      expect(bodies).toEqual([{ questions, deferred: true }])
      expect(JSON.stringify(server_.tools)).toContain('end your turn after it')
    } finally {
      server.close()
    }
  })
})
