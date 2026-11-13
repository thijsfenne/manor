import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { artifactMcpServer } from '../src/mcp/artifactServer.js'
import { routineMcpServer } from '../src/mcp/routineServer.js'
import { skillMcpServer } from '../src/mcp/skillServer.js'
import { toolServerRpc, type JsonRecord, type McpToolServer } from '../src/mcp/stdio.js'
import { workMcpServer } from '../src/mcp/workServer.js'

const cases: { kind: string, server: string, create: (argv: readonly string[]) => McpToolServer, name: string, args: JsonRecord }[] = [
  { kind: 'artifact', server: 'artifacts', create: artifactMcpServer, name: 'artifact_view', args: { ids: ['one'] } },
  { kind: 'routine', server: 'routines', create: routineMcpServer, name: 'routine_save', args: { name: 'Review' } },
  { kind: 'work', server: 'work', create: workMcpServer, name: 'start_work', args: { assignmentKey: 'review', project: ' Manor ', title: 'Review', task: 'Review code' } },
  { kind: 'skill', server: 'skills', create: skillMcpServer, name: 'read_skill', args: { skillId: 'review', path: 'SKILL.md', offset: 0 } },
]

describe('broker MCP tool servers', () => {
  it.each(cases)('$kind preserves protocol, validation, capability and broker errors', async (entry) => {
    const requests: { capability: string | string[] | undefined; body: unknown }[] = []
    const result = entry.kind === 'artifact'
      ? { artifacts: [{ id: 'one', title: 'Reference', preview: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] }
      : { ok: true }
    const broker = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push({ capability: req.headers[`x-manor-${entry.kind}-capability`], body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.setHeader('content-type', 'application/json')
      res.statusCode = requests.length === 1 ? 200 : 403
      res.end(JSON.stringify(requests.length === 1 ? { result } : { error: 'Capability expired.' }))
    })
    broker.listen(0, '127.0.0.1')
    await once(broker, 'listening')
    const address = broker.address()
    if (address === null || typeof address === 'string') throw new Error('Missing broker address')
    try {
      const rpc = toolServerRpc(entry.create(['--broker-url', `http://127.0.0.1:${address.port}`]))
      const send = (message: JsonRecord) => rpc({ jsonrpc: '2.0', ...message }, 'test-capability')
      const init = await send({ id: 1, method: 'initialize' })
      expect(await send({ method: 'notifications/initialized' })).toBeUndefined()
      const list = await send({ id: 2, method: 'tools/list' })
      const ok = await send({ id: 3, method: 'tools/call', params: { name: entry.name, arguments: entry.args } })
      const unknownTool = await send({ id: 4, method: 'tools/call', params: { name: 'unknown' } })
      const refused = await send({ id: 5, method: 'tools/call', params: { name: entry.name, arguments: entry.args } })
      const unknownMethod = await send({ id: 6, method: 'unknown' })

      expect(init?.result).toMatchObject({ protocolVersion: '2024-11-05', serverInfo: { name: `manor-${entry.server}` }, capabilities: { tools: {} } })
      expect((list?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toContain(entry.name)
      const okResult = ok?.result as { isError?: boolean, content: { text: string }[] }
      expect(okResult.isError).toBeUndefined()
      if (entry.kind === 'artifact') {
        expect(okResult.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' })
        expect(JSON.parse(okResult.content[0]?.text ?? '').artifacts[0]).not.toHaveProperty('preview')
      } else expect(JSON.parse(okResult.content[0]?.text ?? '')).toEqual(result)
      expect((unknownTool?.result as { isError: boolean }).isError).toBe(true)
      expect(refused?.result).toEqual({ isError: true, content: [{ type: 'text', text: 'Capability expired.' }] })
      expect((unknownMethod?.error as { code: number }).code).toBe(-32601)
      expect(requests).toHaveLength(2)
      expect(requests[0]?.capability).toBe('test-capability')
      const expectedBody = entry.kind === 'work' ? { ...entry.args, project: 'Manor' }
        : entry.kind === 'skill' ? entry.args : { tool: entry.name, arguments: entry.args }
      expect(requests[0]?.body).toEqual(expectedBody)
    } finally {
      broker.closeAllConnections()
      await new Promise<void>((resolve) => broker.close(() => resolve()))
    }
  })
})
