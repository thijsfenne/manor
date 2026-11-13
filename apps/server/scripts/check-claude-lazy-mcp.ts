import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentConfig, AttachedMcpServer } from '@manor/contracts'
import { withMcpConnections } from '../src/composer.js'
import { LAZY_MCP_ENV, createClaudeDriver } from '../src/drivers/claudeDriver.js'

/**
 * Real-CLI check for `LAZY_MCP_ENV`, which leans on Claude CLI switches outside the
 * documented surface. Run after every Claude CLI update:
 * `pnpm check:claude-lazy-mcp [--baseline] [--model <id>]`.
 *
 * Thirteen fake stdio servers, twelve of them slow, run through the real driver. Three
 * short Haiku turns prove that a turn without connectors starts before the slow servers
 * answer, that Manor's own `ask_user` is callable on the first call without ToolSearch,
 * and that a slow connector's tool is still found and called. `--baseline` strips the
 * lazy env to show the wait it removes; it skips the asserts.
 */

const SLOW_MS = 3_000
const baseline = process.argv.includes('--baseline')
const modelAt = process.argv.indexOf('--model')
const model = modelAt === -1 ? 'claude-haiku-5-5' : process.argv[modelAt + 1] ?? 'claude-haiku-5-5'

const FAKE_SERVER = `
import { createInterface } from 'node:readline'
const [name, delayMs, toolList] = process.argv.slice(2)
const delay = Number(delayMs)
const tools = toolList.split(',')
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    await new Promise((resolve) => setTimeout(resolve, delay))
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '0.0.1' } } })
  } else if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools: tools.map((tool) => ({ name: tool, description: name + ' ' + tool, inputSchema: { type: 'object', properties: { question: { type: 'string' } } } })) } })
  } else if (message.method === 'tools/call') {
    send({ id: message.id, result: { content: [{ type: 'text', text: name + '.' + message.params.name + ' answered: yes' }] } })
  } else if (message.id !== undefined) send({ id: message.id, result: {} })
})
`

interface Observed {
  initMs: number | undefined
  /** Built-in tools and connected servers the CLI reported at init. */
  init?: { tools: string[]; servers: string[] }
  tools: string[]
  results: { tool: string; error: boolean; text: string }[]
  reply: string
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'manor-lazy-mcp-'))
try {
  const serverPath = path.join(dir, 'fake-mcp.mjs')
  await writeFile(serverPath, FAKE_SERVER)
  const fake = (id: string, name: string, tools: string[], delayMs: number): AttachedMcpServer => ({
    server: {
      id, name, command: process.execPath, args: [serverPath, name, String(delayMs), tools.join(',')], envKeys: [],
      description: `The ${name} connection.`, writes: false, effectPolicy: 'trusted',
      tools, readOnlyTools: tools, schemaChars: 0,
    },
    disabledTools: [],
  })
  const attached = [
    fake('builtin_manor', 'manor', ['ask_user'], 100),
    fake('calendar', 'calendar', ['list_events'], SLOW_MS),
    ...Array.from({ length: 11 }, (_, index) => fake(`filler_${index}`, `filler_${index}`, ['search', 'fetch'], SLOW_MS)),
  ]
  const agent = withMcpConnections({
    id: 'probe', name: 'Probe', color: '#888888', driver: 'claude', model, effort: 'low',
    allowedTools: [], mcpServers: [], memoryScope: false, role: '', description: '', isCos: false,
    character: 'You are a terse assistant in a test harness. Follow the instruction exactly.',
  }, attached)

  const turn = async (prompt: string): Promise<Observed> => {
    const observed: Observed = { initMs: undefined, tools: [], results: [], reply: '' }
    const names = new Map<string, string>()
    const driver = createClaudeDriver({
      agents: () => [agent],
      timeoutMs: 180_000,
      spawnFn: (command, args, options) => {
        const env = { ...options.env }
        if (baseline) for (const key of Object.keys(LAZY_MCP_ENV)) delete env[key]
        const started = Date.now()
        const child = spawn(command, args, { ...options, env, stdio: ['pipe', 'pipe', 'pipe'] })
        let buffer = ''
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const event = JSON.parse(line) as {
              type?: string; subtype?: string; result?: string; message?: { content?: unknown }
              tools?: string[]; mcp_servers?: { name: string; status: string }[]
            }
            if (event.type === 'system' && event.subtype === 'init' && observed.initMs === undefined) {
              observed.initMs = Date.now() - started
              observed.init = {
                tools: (event.tools ?? []).filter((tool) => !tool.startsWith('mcp__')),
                servers: (event.mcp_servers ?? []).map(({ name, status }) => `${name}:${status}`),
              }
            }
            if (event.type === 'result') observed.reply = event.result ?? ''
            const blocks = Array.isArray(event.message?.content) ? event.message.content as Record<string, unknown>[] : []
            for (const block of blocks) {
              if (event.type === 'assistant' && block.type === 'tool_use') {
                observed.tools.push(String(block.name))
                names.set(String(block.id), String(block.name))
              }
              if (event.type === 'user' && block.type === 'tool_result') {
                observed.results.push({
                  tool: names.get(String(block.tool_use_id)) ?? '?',
                  error: block.is_error === true,
                  text: JSON.stringify(block.content),
                })
              }
            }
          }
        })
        return child
      },
    })
    const handle = driver.startTurn({
      agent, threadId: 'lazy-mcp-check', cwd: dir, repoPaths: [], isFullCatchUp: true, mcpServers: attached,
      catchUp: [{ id: 'evt_000001', ts: Date.now(), type: 'user_message', text: prompt, mentions: [] }],
    })
    for await (const event of handle.events) if (event.type === 'error') throw new Error(event.message)
    return observed
  }

  const quick = await turn('Reply with only the word ok.')
  const inTurn = await turn('Call the ask_user tool with the question "ping". Then reply with exactly what it returned.')
  const connector = await turn('Use the calendar connection to list my events. Then reply with exactly what the tool returned.')
  console.log(JSON.stringify({ baseline, model, quick, inTurn, connector }, null, 2))
  if (!baseline) {
    assert.ok(quick.initMs !== undefined && quick.initMs < 1_000, `A turn without connectors waited ${quick.initMs}ms before its first request`)
    assert.equal(inTurn.tools[0], 'mcp__manor__ask_user', 'ask_user was not called directly on the first call')
    assert.ok(inTurn.results.some(({ tool, error, text }) => tool === 'mcp__manor__ask_user' && !error && text.includes('answered: yes')), 'ask_user did not answer')
    const called = connector.tools.indexOf('mcp__calendar__list_events')
    assert.ok(called > 0 && connector.tools.slice(0, called).includes('ToolSearch'), 'The slow connector was not loaded through ToolSearch')
    assert.ok(connector.results.some(({ tool, error, text }) => tool === 'mcp__calendar__list_events' && !error && text.includes('answered: yes')), 'The slow connector did not answer')
    console.log(`Lazy MCP works on this CLI. No-connector turn started after ${quick.initMs}ms against ${SLOW_MS}ms server startup.`)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
