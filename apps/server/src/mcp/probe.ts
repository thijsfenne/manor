import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mcpHttpUrl, type McpServerDraft } from '@manor/contracts'
import { appendChildErrorTail, childProcessEnv, redactGrantedEnvValues } from '../childEnv.js'
import { desktopTools } from '../computerPolicy.js'
import { probeHttpMcpServer } from './httpProbe.js'
import { accessTokenFor } from './oauth.js'
import { resolveMcpHttpHeaders } from './httpHeaders.js'
import { readOnlyToolNames, type McpProbeResult } from './probeResult.js'

export { readOnlyToolNames, type McpProbeResult }

/**
 * Speaks MCP to a stdio server directly, once, to learn what attaching it would cost
 * and whether it starts at all. Costs no model tokens.
 *
 * This exists because both failure modes it catches are silent otherwise. A server
 * whose command is missing, or whose `${KEY}` has no value in the environment, does
 * not start; the CLI reports `status: "failed"` on its init line and the model is
 * told nothing, so a persona quietly answers from memory with no tools. Probing at
 * registration turns that into an error on the form instead of a mystery in a chat.
 *
 * The second reason is price. An eagerly loaded server costs roughly 0,42 tokens per
 * character of tool schemas plus the server's `instructions` block, per persona, per
 * turn (measured against Context7 and Supabase; see the idea note). `schemaChars` is
 * what that estimate multiplies.
 */

/** Protocol version this probe speaks; servers negotiate down if they must. */
const PROTOCOL_VERSION = '2025-06-18'

const DEFAULT_TIMEOUT_MS = 20_000

const availableTcpPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not reserve a temporary port for the MCP probe'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })

interface ProbeOptions {
  timeoutMs?: number
  /** The environment the server is started in; defaults to the server process's own. */
  env?: NodeJS.ProcessEnv
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * The shape the CLI presents each MCP tool to the model in. Serialised here so the
 * character count describes what actually lands in the request body rather than what
 * the server happened to send over the wire.
 */
const toolShape = (serverName: string, tool: Record<string, unknown>) => ({
  name: `mcp__${serverName}__${String(tool['name'] ?? '')}`,
  description: tool['description'] ?? '',
  input_schema: tool['inputSchema'] ?? {},
})

/**
 * Starts the server, runs the initialize handshake, asks for its tools, and kills it.
 * Rejects with a readable message when the command cannot start, when the server
 * errors, or when it says nothing for `timeoutMs`.
 *
 * `envKeys` are resolved here, from the environment this server process runs in. A
 * key with no value is an error rather than an empty string, because an empty
 * credential is exactly the silent failure this function exists to prevent.
 */
export async function probeMcpServer(draft: McpServerDraft, options: ProbeOptions = {}): Promise<McpProbeResult> {
  const httpUrl = mcpHttpUrl(draft)
  if (httpUrl !== undefined) {
    const hostEnv = options.env ?? process.env
    const headers = resolveMcpHttpHeaders(draft, hostEnv)
    const bearer = await accessTokenFor(httpUrl)
    return probeHttpMcpServer(draft, { timeoutMs: options.timeoutMs, bearer, headers })
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const hostEnv = options.env ?? process.env
  const missing: string[] = []
  for (const key of draft.envKeys) {
    const value = hostEnv[key]
    if (value === undefined || value.length === 0) missing.push(key)
  }
  if (missing.length > 0) {
    throw new Error(
      `the environment of this server has no value for ${missing.join(', ')}; ` +
        'set it on the machine Manor runs on, it is never stored by Manor',
    )
  }
  // Some nominally stdio-only packages also start an HTTP listener unconditionally.
  // A probe is a second short-lived instance, so isolate that unused listener instead
  // of colliding with the attached server's fixed default port.
  const env = childProcessEnv(hostEnv, draft.envKeys, { PORT: String(await availableTcpPort()) })
  const redact = (message: string) => redactGrantedEnvValues(message, hostEnv, draft.envKeys)

  return new Promise<McpProbeResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(draft.command, [...draft.args], { stdio: ['pipe', 'pipe', 'pipe'], env })
    } catch (error: unknown) {
      reject(new Error(redact(`could not start ${draft.command}: ${(error as Error).message}`)))
      return
    }

    let settled = false
    let buffer = ''
    let stderr = ''
    let instructions = ''
    let discovered: Omit<McpProbeResult, 'verifiedBy'> | undefined

    const finish = (outcome: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      outcome()
    }

    const fail = (message: string) => {
      // The server's own complaint beats a generic message; a missing binary or a
      // rejected token almost always says why on stderr.
      const detail = stderr.trim().length > 0 ? `: ${stderr.trim().slice(-300)}` : ''
      finish(() => reject(new Error(redact(`${message}${detail}`))))
    }

    const timer = setTimeout(() => fail(`${draft.command} did not answer within ${timeoutMs}ms`), timeoutMs)

    const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length === 0) continue
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          // Servers print startup banners on stdout; only JSON-RPC lines matter.
          continue
        }
        if (!isRecord(message)) continue

        if (message['id'] === 1) {
          const result = message['result']
          if (isRecord(result) && typeof result['instructions'] === 'string') {
            instructions = result['instructions']
          }
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
          continue
        }

        if (message['id'] === 2) {
          const error = message['error']
          if (isRecord(error)) {
            fail(`${draft.command} refused tools/list: ${String(error['message'] ?? 'unknown error')}`)
            return
          }
          const result = message['result']
          const listed = isRecord(result) && Array.isArray(result['tools']) ? result['tools'] : []
          // A computer connector's cost is what the Manor allowlist lets through.
          const allowed = desktopTools(draft.name)
          const tools = listed.filter(isRecord).filter((tool) =>
            allowed === undefined || allowed.includes(String(tool['name'])))
          const payload = tools.map((tool) => toolShape(draft.name, tool))
          discovered = {
            tools: tools.map((tool) => String(tool['name'] ?? '')).filter((name) => name.length > 0),
            readOnlyTools: readOnlyToolNames(draft.name, tools),
            schemaChars: JSON.stringify(payload).length + instructions.length,
          }
          // MCP has no universal credential check, and calling an arbitrary tool can
          // mutate data. Gmail's get_profile is known, side-effect-free and takes no
          // arguments, so it is the first explicit functional probe Manor supports.
          if (discovered.tools.includes('get_profile')) {
            send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_profile', arguments: {} } })
            continue
          }
          finish(() => resolve(discovered!))
          return
        }

        if (message['id'] === 3) {
          const error = message['error']
          const result = message['result']
          const content = isRecord(result) && Array.isArray(result['content']) ? result['content'] : []
          const textPayloads = content
            .filter(isRecord)
            .map((item) => item['text'])
            .filter((text): text is string => typeof text === 'string')
          const returnedError = textPayloads.some((text) => {
            try {
              const parsed = JSON.parse(text) as unknown
              return isRecord(parsed) && typeof parsed['error'] === 'string'
            } catch {
              return false
            }
          })
          if (isRecord(error) || (isRecord(result) && result['isError'] === true) || returnedError) {
            fail(`${draft.command} started, but get_profile could not verify its credential`)
            return
          }
          finish(() => resolve({ ...discovered!, verifiedBy: 'get_profile' }))
          return
        }
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendChildErrorTail(stderr, chunk, redact)
    })

    child.on('error', (error: Error) => {
      finish(() => reject(new Error(redact(`could not start ${draft.command}: ${error.message}`))))
    })

    child.on('close', (code) => {
      fail(`${draft.command} exited with code ${code ?? 'unknown'} before listing its tools`)
    })

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'manor', version: '0' },
      },
    })
  })
}

/**
 * The input-token cost of attaching a server, per persona per turn, when its tools
 * are loaded eagerly. Measured constant, accurate to within a few percent on the two
 * verbose real servers it was fitted against and about 20% high on a terse one.
 */
export const estimateEagerTokens = (schemaChars: number): number => Math.round(schemaChars * 0.42)
