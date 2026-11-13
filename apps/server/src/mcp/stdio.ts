import { createInterface } from 'node:readline'

export type JsonRecord = Record<string, unknown>
export const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null
/** Refuses a call still queued when its turn ended. */
export const TURN_ENDED = 'This turn has ended.'

export function option(name: string, argv: readonly string[] = process.argv): string {
  const at = argv.indexOf(name)
  const value = at === -1 ? undefined : argv[at + 1]
  if (value === undefined || value === '') throw new Error(`Missing ${name}.`)
  return value
}

/**
 * One of Manor's turn-scoped tool servers, independent of how it is reached: a stdio
 * child (`serveMcp`) or the Manor server's own HTTP endpoint (`McpHttpHost`).
 */
export interface McpToolServer {
  name: string
  tools: readonly JsonRecord[]
  instructions?: string
  failureMessage: string
  /** The capability rides with each call, because a live provider process may hold a rekeyed token. */
  callTool: (name: unknown, arguments_: JsonRecord, capability: string) => Promise<JsonRecord[]>
  /**
   * Calls answered out of order. Providers may emit several consultation or subagent
   * calls together; each must reach Manor before the first one's wait blocks the rest.
   * Every other call runs after the previous one finished, as a stdio pipe always did.
   */
  concurrent?: (name: string) => boolean
}

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/**
 * Answers one JSON-RPC message; undefined for a notification, which gets no answer.
 * Answers keep request order, as a stdio pipe always did, except `concurrent` calls.
 */
export function toolServerRpc(server: McpToolServer): (request: JsonRecord, capability: string, closed?: AbortSignal) => Promise<JsonRecord | undefined> {
  let queue: Promise<unknown> = Promise.resolve()
  const answer = async (request: JsonRecord, id: unknown, capability: string, closed?: AbortSignal): Promise<JsonRecord> => {
    if (request.method === 'initialize') {
      const params = isRecord(request.params) ? request.params : {}
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: '0.1.0' },
        ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
      } }
    }
    if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: server.tools } }
    if (request.method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } }
    const params = isRecord(request.params) ? request.params : {}
    const arguments_ = isRecord(params.arguments) ? params.arguments : {}
    try {
      // A call still queued when its turn ended must not run under a rekeyed capability.
      if (closed?.aborted === true) throw new Error(TURN_ENDED)
      const content = await server.callTool(params.name, arguments_, capability)
      return { jsonrpc: '2.0', id, result: { content } }
    } catch (error: unknown) {
      return { jsonrpc: '2.0', id, result: {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : server.failureMessage }],
      } }
    }
  }
  return async (request, capability, closed) => {
    const id = request.id
    if (id === undefined || id === null) return undefined
    const name = isRecord(request.params) ? request.params.name : undefined
    if (request.method === 'tools/call' && typeof name === 'string' && server.concurrent?.(name) === true) {
      // Starts after the earlier serial calls, but holds up none of the later ones.
      return queue.then(() => answer(request, id, capability, closed))
    }
    const next = queue.then(() => answer(request, id, capability, closed))
    queue = next
    return next
  }
}

/** Stdio transport for a turn-scoped tool server; the capability comes from the child's env. */
export async function serveMcp(server: McpToolServer, capability: string): Promise<void> {
  const rpc = toolServerRpc(server)
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const send = (message: JsonRecord) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const pending = new Set<Promise<void>>()
  for await (const line of input) {
    let request: unknown
    try { request = JSON.parse(line) } catch { continue }
    if (!isRecord(request) || request.jsonrpc !== '2.0') continue
    const answer = rpc(request, capability).then((reply) => { if (reply !== undefined) send(reply) })
    pending.add(answer)
    void answer.finally(() => pending.delete(answer))
  }
  await Promise.allSettled(pending)
}
