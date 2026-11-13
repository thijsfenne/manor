// A stdio MCP server that speaks just enough of the protocol for the probe test:
// initialize, then tools/list. Behaviour is steered by argv so one fixture covers
// the happy path and the failure modes.
//
//   node fakeMcpServer.mjs              two tools, no instructions
//   node fakeMcpServer.mjs --instructions   the same, plus an instructions block
//   node fakeMcpServer.mjs --needs-token    exits 1 unless FAKE_TOKEN is set
//   node fakeMcpServer.mjs --leak-token     echoes FAKE_TOKEN to stderr and exits
//   node fakeMcpServer.mjs --refuse         answers tools/list with an error
//   node fakeMcpServer.mjs --cua            lists Cua-shaped computer tools
//   node fakeMcpServer.mjs --codex-computer asks Codex-engine-shaped elicitations
//   node fakeMcpServer.mjs --silent         never answers, for the timeout path
//   node fakeMcpServer.mjs --profile        offers a safe functional credential probe
//   node fakeMcpServer.mjs --profile-error  offers that probe but rejects its credential
//   node fakeMcpServer.mjs --bind-port     also binds the PORT environment value
import { createServer } from 'node:net'
import { appendFileSync } from 'node:fs'

const flags = new Set(process.argv.slice(2))

if (flags.has('--bind-port')) {
  createServer().listen(Number(process.env.PORT ?? 3000))
}

if (process.env.FAKE_ENV_DUMP) {
  appendFileSync(process.env.FAKE_ENV_DUMP, `${JSON.stringify({
    HOME: process.env.HOME ?? null,
    SIBLING_SECRET: process.env.SIBLING_SECRET ?? null,
    FAKE_CALL_MARKER: process.env.FAKE_CALL_MARKER ?? null,
  })}\n`)
}

if (flags.has('--needs-token') && !process.env.FAKE_TOKEN) {
  process.stderr.write('FAKE_TOKEN is not set\n')
  process.exit(1)
}

if (flags.has('--leak-token')) {
  process.stderr.write(`provider rejected ${process.env.FAKE_TOKEN}\n`)
  process.exit(1)
}

const INSTRUCTIONS = 'Prefer list_rows before write_row. '.repeat(4)

const TOOLS = [
  {
    name: 'list_rows',
    description: 'List rows in a table.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
  },
  {
    name: 'write_row',
    description: 'Write one row.',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, row: { type: 'object' } } },
  },
]

if (flags.has('--profile') || flags.has('--profile-error')) {
  TOOLS.push({
    name: 'get_profile',
    description: "Get the current user's profile.",
    inputSchema: { type: 'object', properties: {} },
  })
}

// Cua-shaped: an allowlisted read and write next to two tools Manor never exposes.
if (flags.has('--cua')) {
  TOOLS.splice(0, TOOLS.length, ...['get_window_state', 'click', 'bring_to_front', 'kill_app'].map((name) => ({
    name, description: `${name}.`, inputSchema: { type: 'object', properties: {} },
  })))
}

// Codex-engine-shaped: js asks for app access through elicitation before it answers.
if (flags.has('--codex-computer')) {
  TOOLS.splice(0, TOOLS.length, ...['js', 'js_add_node_module_dir', 'js_reset', 'turn_ended'].map((name) => ({
    name, description: `${name}.`, inputSchema: { type: 'object', properties: {} },
  })))
}
const elicitation = (message, tool = 'get_app_state') => ({
  mode: 'form', message, requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', tool_name: tool },
})
const asked = new Map()
const mark = (line) => { if (process.env.FAKE_CALL_MARKER) appendFileSync(process.env.FAKE_CALL_MARKER, `${line}\n`) }

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

// Real servers print banners on stdout before the handshake; the probe must skip them.
process.stdout.write('fake mcp server starting\n')

let buffer = ''
let executorReply
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (flags.has('--silent')) continue
    if (message.id === 'fixture_ping' && executorReply) {
      send(executorReply)
      executorReply = undefined
      continue
    }
    if (flags.has('--codex-computer') && typeof message.id === 'string' && message.id.startsWith('elicit_')) {
      const call = asked.get(message.id)
      asked.delete(message.id)
      if (call === undefined) mark(`unsolicited:${message.result?.action}`)
      else send({ jsonrpc: '2.0', id: call, result: { content: [{ type: 'text', text: `js:${message.result?.action}` }] } })
      continue
    }
    if (flags.has('--codex-computer') && message.method === 'notifications/initialized') {
      send({ jsonrpc: '2.0', id: 'elicit_unsolicited', method: 'elicitation/create',
        params: elicitation('Allow Computer Use to use "Finder"?') })
      continue
    }
    if (message.id === 1) {
      if (flags.has('--codex-computer')) mark(`elicitation:${JSON.stringify(message.params?.capabilities?.elicitation ?? null)}`)
      send({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '0' },
          ...(flags.has('--instructions') ? { instructions: INSTRUCTIONS } : {}),
        },
      })
      continue
    }
    if (message.id === 2) {
      if (flags.has('--refuse')) send({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'no tools for you' } })
      else send({ jsonrpc: '2.0', id: 2, result: { tools: TOOLS } })
      continue
    }
    if (message.id === 3) {
      send({
        jsonrpc: '2.0',
        id: 3,
        result: {
          content: [
            {
              type: 'text',
              text: flags.has('--profile-error')
                ? JSON.stringify({ error: 'Authentication failed' })
                : JSON.stringify({ emailAddress: 'person@example.com' }),
            },
          ],
        },
      })
      continue
    }
    if (message.method === 'tools/call') {
      const name = typeof message.params?.name === 'string' ? message.params.name : 'unknown'
      if (process.env.FAKE_CALL_MARKER) appendFileSync(process.env.FAKE_CALL_MARKER, `${name}\n`)
      if (flags.has('--codex-computer')) {
        const id = `elicit_${message.id}`
        asked.set(id, message.id)
        send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: message.params?.arguments?.code === 'audio'
          ? elicitation('Allow Computer Use to record computer audio?', 'start_audio_recording')
          : elicitation('Allow Computer Use to use "Calculator"?') })
        continue
      }
      if (flags.has('--executor')) {
        const reply = { jsonrpc: '2.0', id: message.id, result: { structuredContent: name === 'execute' ? {
          status: 'waiting_for_interaction', executionId: 'exec_fixture', interaction: {
            kind: 'form', message: 'Allow Computer Use to use "Finder"?',
            address: 'tools.codex_computer_use.org.localComputerUse.get_app_state', args: { app: 'Finder' },
            requestedSchema: { type: 'object', properties: {} }, meta: { connector_id: 'computer-use' },
          },
        } : { status: 'completed', result: 'Finder ready' } } }
        if (flags.has('--executor-ping') && name === 'execute') {
          executorReply = reply
          send({ jsonrpc: '2.0', id: 'fixture_ping', method: 'ping' })
        } else send(reply)
        continue
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `called:${name}` }] },
      })
    }
  }
})
