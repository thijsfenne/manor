import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { appendChildErrorTail, redactGrantedEnvValues, upstreamProcessEnv } from '../childEnv.js'
import { CODEX_COMPUTER_MCP_NAME, codexAppAccess } from '../computerPolicy.js'
import type { EffectProxyUpstream } from './effectProxyAttachment.js'
import { ExecutorSession } from './executorSession.js'
import { HttpConnector, authorize, deniedResult, takeBrokerEnv, toolCallName, toolResult } from './httpConnector.js'

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null

function option(name: string): string {
  const at = process.argv.indexOf(name)
  const value = at === -1 ? undefined : process.argv[at + 1]
  if (value === undefined || value === '') throw new Error(`Missing ${name}.`)
  return value
}

function upstreamOption(): EffectProxyUpstream {
  const parsed: unknown = JSON.parse(Buffer.from(option('--upstream'), 'base64url').toString('utf8'))
  if (
    !isRecord(parsed) ||
    typeof parsed.name !== 'string' ||
    typeof parsed.command !== 'string' ||
    !Array.isArray(parsed.args) || !parsed.args.every((value) => typeof value === 'string') ||
    !Array.isArray(parsed.envKeys) || !parsed.envKeys.every((value) => typeof value === 'string') ||
    !isRecord(parsed.httpHeaders) || !Object.values(parsed.httpHeaders).every((value) => typeof value === 'string') ||
    !(parsed.url === undefined || typeof parsed.url === 'string') ||
    !(parsed.bearerEnvKey === undefined || typeof parsed.bearerEnvKey === 'string') ||
    !(parsed.allowTools === undefined ||
      (Array.isArray(parsed.allowTools) && parsed.allowTools.every((value) => typeof value === 'string')))
  ) throw new Error('Invalid effect-proxy upstream configuration.')
  return parsed as unknown as EffectProxyUpstream
}

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)

async function runStdio(
  upstream: EffectProxyUpstream,
  brokerUrl: string,
  capability: string,
  secretEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const sourceEnv = { ...process.env, ...secretEnv }
  const env = upstreamProcessEnv(sourceEnv, upstream.envKeys)
  const child = spawn(upstream.command, upstream.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const redact = (value: string) => redactGrantedEnvValues(value, sourceEnv, upstream.envKeys)
  let stderr = ''

  const pending = new Map<string, { resolve: (result: JsonRecord) => void; reject: (error: Error) => void }>()
  const executor = upstream.name === 'executor' ? new ExecutorSession(
    (tool, args, review, continuation) => authorize(brokerUrl, capability, upstream.name, tool, args, review, continuation),
    (tool, args) => new Promise<JsonRecord>((resolve, reject) => {
      if (child.killed || child.exitCode !== null || !child.stdin.writable) {
        reject(new Error('Executor closed before the call was approved.'))
        return
      }
      const id = `manor_${randomUUID()}`
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } })}\n`)
    }),
  ) : undefined
  const allow = upstream.allowTools === undefined ? undefined : new Set(upstream.allowTools)
  const listRequests = new Set<unknown>()
  // Codex's engine asks before each app; Manor answers here, inside a call the lease admitted.
  const answersAppAccess = upstream.name === CODEX_COMPUTER_MCP_NAME
  const admittedCalls = new Set<unknown>()
  if (executor === undefined && allow === undefined) child.stdout.pipe(process.stdout)
  else createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    let message: unknown
    try { message = JSON.parse(line) } catch { process.stdout.write(`${line}\n`); return }
    if (answersAppAccess && isRecord(message) && message.method === 'elicitation/create' && message.id !== undefined) {
      const result = admittedCalls.size > 0 && codexAppAccess(message.params)
        ? { action: 'accept', content: {} } : { action: 'decline' }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
      return
    }
    if (isRecord(message) && message.method === undefined) admittedCalls.delete(message.id)
    if (allow !== undefined && isRecord(message) && listRequests.delete(message.id)) {
      send(allowedToolList(message, allow))
      return
    }
    const request = isRecord(message) && typeof message.id === 'string' ? pending.get(message.id) : undefined
    if (request === undefined || !isRecord(message)) { send(message); return }
    pending.delete(String(message.id))
    try { request.resolve(toolResult(message)) } catch (error: unknown) {
      request.reject(error instanceof Error ? error : new Error('Executor call failed.'))
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = appendChildErrorTail(stderr, chunk, redact)
    process.stderr.write(redact(chunk))
  })
  child.on('error', (error) => process.stderr.write(`[manor-effect-proxy] ${redact(error.message)}\n`))
  child.on('close', (code) => {
    for (const request of pending.values()) request.reject(new Error('Executor closed before answering.'))
    pending.clear()
    if (code !== 0 && stderr.trim().length === 0) {
      process.stderr.write(`[manor-effect-proxy] ${upstream.name} exited with code ${code ?? 'unknown'}\n`)
    }
    process.exitCode = code ?? 1
  })

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const stop = () => {
    input.close()
    child.kill('SIGTERM')
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  child.once('close', () => input.close())

  let queue = Promise.resolve()
  let closed = false
  input.on('line', (line) => {
    let message: unknown
    try { message = JSON.parse(line) } catch { return }
    if (!isRecord(message)) return
    const request = message
    const tool = toolCallName(request)
    if (request.method === 'tools/list' && request.id !== undefined) listRequests.add(request.id)
    // The engine only asks clients that declare form elicitation, and the answer comes from here.
    if (answersAppAccess && request.method === 'initialize' && isRecord(request.params)) {
      const capabilities = isRecord(request.params.capabilities) ? request.params.capabilities : {}
      const initialize = { ...request, params: { ...request.params, capabilities: { ...capabilities, elicitation: { form: {} } } } }
      child.stdin.write(`${JSON.stringify(initialize)}\n`)
      return
    }
    // Protocol replies must reach the upstream while a tool
    // is still running. Only tool calls wait for the preceding call to finish.
    if (tool === undefined) { child.stdin.write(`${line}\n`); return }
    queue = queue.then(async () => {
      if (closed) return
      try {
        if (tool.length === 0) throw new Error('MCP tools/call had no tool name.')
        if (allow !== undefined && !allow.has(tool)) throw new Error(`${upstream.name}.${tool} is not available in Manor.`)
        const args = isRecord(request.params) ? request.params.arguments : undefined
        if (executor !== undefined && (tool === 'execute' || tool === 'resume')) {
          const result = await executor.run(tool, args)
          send({ jsonrpc: '2.0', id: request.id, result })
        } else {
          await authorize(brokerUrl, capability, upstream.name, tool, args)
          if (closed) return
          admittedCalls.add(request.id)
          child.stdin.write(`${line}\n`)
        }
      } catch (error: unknown) {
        send(deniedResult(request.id, error instanceof Error ? error.message : 'Connector call denied.'))
      }
    })
  })
  await new Promise<void>((resolve) => input.once('close', () => {
    closed = true
    if (child.exitCode === null) child.kill('SIGTERM')
    resolve()
  }))
  await queue
}

async function runHttp(
  upstream: EffectProxyUpstream,
  brokerUrl: string,
  capability: string,
  secretEnv: NodeJS.ProcessEnv,
): Promise<void> {
  // The proxy child's own env is already narrowed to this connector's keys.
  const connector = new HttpConnector(upstream, brokerUrl, send, { ...process.env, ...secretEnv })
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of input) {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(message)) continue
    for (const reply of await connector.handle(message, capability)) send(reply)
  }
}

/** The model sees only the Manor allowlist; the broker refuses the rest anyway. */
function allowedToolList(message: JsonRecord, allow: ReadonlySet<string>): JsonRecord {
  if (!isRecord(message.result) || !Array.isArray(message.result.tools)) return message
  const tools = message.result.tools.filter((tool) => isRecord(tool) && typeof tool.name === 'string' && allow.has(tool.name))
  return { ...message, result: { ...message.result, tools } }
}

async function main(): Promise<void> {
  const brokerUrl = option('--broker-url')
  const capabilityEnv = option('--capability-env')
  const capability = process.env[capabilityEnv]
  if (capability === undefined || capability === '') throw new Error('The effect broker capability is missing.')
  const upstream = upstreamOption()
  const secretEnv = await takeBrokerEnv(brokerUrl, capability)
  if (upstream.url === undefined) await runStdio(upstream, brokerUrl, capability, secretEnv)
  else await runHttp(upstream, brokerUrl, capability, secretEnv)
}

void main().catch((error: unknown) => {
  process.stderr.write(`[manor-effect-proxy] ${error instanceof Error ? error.message : 'startup failed'}\n`)
  process.exitCode = 1
})
