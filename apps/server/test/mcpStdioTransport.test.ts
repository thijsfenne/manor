import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serveMcp } from '../src/mcp/stdio.js'

describe('the stdio MCP transport', () => {
  afterEach(() => vi.restoreAllMocks())

  it('skips lines that are not JSON-RPC and still answers every request, then ends with stdin', async () => {
    const lines = [
      'not json',
      '{}',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ]
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(lines.map((line) => `${line}\n`)) as unknown as typeof process.stdin)
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { written.push(String(chunk)); return true })

    await serveMcp({ name: 'manor-test', tools: [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object' } }], failureMessage: 'Ping failed.', callTool: async () => [] }, 'capability')

    const replies = written.map((line) => JSON.parse(line))
    expect(replies.map((reply) => reply.id)).toEqual([1, 2])
    expect(replies[1].result.tools).toEqual([expect.objectContaining({ name: 'ping' })])
  })
})
