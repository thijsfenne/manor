import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { mcpHttpUrl, type AttachedMcpServer, type McpServerDraft } from '@manor/contracts'
import { upstreamProcessEnv } from '../childEnv.js'
import { terminateCliTree, trackCliChild } from '../drivers/childTermination.js'
import { calendarMcpDraft } from './calendarRegistration.js'
import type { EffectProxyUpstream } from './effectProxyAttachment.js'
import { authorize, deniedResult, toolCallName } from './httpConnector.js'
import type { McpEndpoint } from './httpHost.js'
import { mailMcpDraft } from './mailAttachment.js'
import { derivedRuntimeUnchanged } from './mailRegistration.js'
import { remindersMcpDraft } from './remindersRegistration.js'
import { PROTOCOL_VERSIONS, TURN_ENDED, isRecord, type JsonRecord } from './stdio.js'

/** A shared upstream nobody used for this long exits; the next call starts it again. */
const IDLE_MS = 10 * 60_000
/** An upstream that has not answered initialize by then is stopped, so it cannot hold up every later turn. */
const START_MS = 30_000
/**
 * Manor's servers answer one call at a time, so a call that never returns would hold
 * every thread's calls behind it. Past this the process is stopped and the next call
 * starts a fresh one.
 */
const CALL_MS = 2 * 60_000
const UPSTREAM_PROTOCOL_VERSION = '2025-06-18'

let sharedDrafts: readonly McpServerDraft[] | undefined

/**
 * Stdio rows one shared process serves for every turn: Manor's own mail, calendar and
 * reminders servers, and only while the row still runs this runtime's build of them. A
 * row of that name pointing anywhere else, or any third-party server, keeps a process
 * per turn: it may hold state per connection (a selected project, a browser page,
 * computer use's implicit session) that a shared one would carry between threads.
 */
export function sharesStdioProcess(attached: AttachedMcpServer): boolean {
  if (mcpHttpUrl(attached.server) !== undefined) return false
  sharedDrafts ??= [mailMcpDraft(), calendarMcpDraft(), remindersMcpDraft()]
  return sharedDrafts.some((draft) => draft.name === attached.server.name && derivedRuntimeUnchanged(attached.server, draft))
}

interface Pending {
  resolve: (reply: JsonRecord) => void
  reject: (error: Error) => void
}

const cancelledBy = (signal: AbortSignal | undefined): Promise<never> => new Promise((_resolve, reject) => {
  if (signal === undefined) return
  if (signal.aborted) reject(new Error(TURN_ENDED))
  else signal.addEventListener('abort', () => reject(new Error(TURN_ENDED)), { once: true })
})

/**
 * One stdio MCP server process shared by every turn that has its row attached.
 * Each caller's request gets an id of the pool's own, so two turns that both send
 * id 1 never receive each other's answers. Requests from the server to a client
 * (sampling, roots) have no single client to go to and are refused. Its stderr is
 * dropped: it may hold one thread's request content, and every thread shares it.
 */
export class PooledStdio {
  private child: ChildProcess | undefined
  private ready: Promise<JsonRecord> | undefined
  private readonly pending = new Map<string, Pending>()
  private next = 0
  private idle: NodeJS.Timeout | undefined
  private closed = false

  constructor(
    readonly upstream: EffectProxyUpstream,
    private readonly env: NodeJS.ProcessEnv,
    private readonly timing: { idleMs?: number; startMs?: number; callMs?: number } = {},
  ) {}

  /** The upstream's initialize result, starting the process on first use. */
  initialize(cancelled?: AbortSignal): Promise<JsonRecord> {
    if (this.closed) return Promise.reject(new Error(`${this.upstream.name} is closed.`))
    this.ready ??= this.start()
    return Promise.race([this.ready, cancelledBy(cancelled)])
  }

  /** Answers one request with the upstream's reply; `cancelled` tells the upstream to stop. */
  async request(method: string, params: unknown, cancelled?: AbortSignal): Promise<JsonRecord> {
    await this.initialize(cancelled)
    return this.send(method, params, this.timing.callMs ?? CALL_MS, cancelled)
  }

  /** Final: a closed upstream never starts again. */
  close(): void {
    this.closed = true
    this.retire(`${this.upstream.name} stopped.`)
  }

  get running(): boolean {
    return this.child !== undefined
  }

  private async start(): Promise<JsonRecord> {
    // Its own group, so shutdown and retirement reach what a wrapper such as npx started.
    // No turn's folder: the process outlives the turn that started it and serves every thread.
    const child = spawn(this.upstream.command, this.upstream.args, {
      cwd: tmpdir(), env: this.env, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
    })
    this.child = child
    trackCliChild(child)
    child.stdin?.on('error', () => undefined)
    if (child.stdout !== null) createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => this.receive(child, line))
    const ended = (reason: string) => {
      if (this.child !== child) return
      this.detach()
      const error = new Error(`${this.upstream.name} stopped (${reason}).`)
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
      console.warn(`[manor] shared ${error.message}`)
    }
    child.on('error', () => ended('could not start'))
    child.on('close', (code, signal) => ended(`exit ${code ?? signal ?? 'unknown'}`))

    try {
      const reply = await this.send('initialize', {
        protocolVersion: UPSTREAM_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'manor', version: '0.1.0' },
      }, this.timing.startMs ?? START_MS)
      if (!isRecord(reply.result)) throw new Error(`${this.upstream.name} did not initialize.`)
      this.write(child, { jsonrpc: '2.0', method: 'notifications/initialized' })
      return reply.result
    } catch (error: unknown) {
      if (this.child === child) this.retire(`${this.upstream.name} stopped.`)
      throw error
    }
  }

  /** Past `deadlineMs` the whole process is stopped: the server is stuck, not this one call. */
  private send(method: string, params: unknown, deadlineMs: number, cancelled?: AbortSignal): Promise<JsonRecord> {
    const child = this.child
    if (child === undefined) return Promise.reject(new Error(`${this.upstream.name} is not running.`))
    if (cancelled?.aborted === true) return Promise.reject(new Error(TURN_ENDED))
    clearTimeout(this.idle)
    const id = `manor_${this.next += 1}`
    return new Promise<JsonRecord>((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (this.pending.has(id) && this.child === child) this.retire(`${this.upstream.name} did not answer in time.`)
      }, deadlineMs)
      const done = () => {
        clearTimeout(deadline)
        cancelled?.removeEventListener('abort', abort)
      }
      const abort = () => {
        if (!this.pending.delete(id)) return
        done()
        this.write(child, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: TURN_ENDED } })
        this.settled()
        reject(new Error(TURN_ENDED))
      }
      cancelled?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve: (reply) => { done(); resolve(reply) },
        reject: (error) => { done(); reject(error) },
      })
      this.write(child, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  private receive(child: ChildProcess, line: string): void {
    let message: unknown
    try { message = JSON.parse(line) } catch { return }
    if (!isRecord(message)) return
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        this.write(child, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'A shared Manor connector answers no server requests.' } })
      }
      return
    }
    const id = typeof message.id === 'string' ? message.id : undefined
    const request = id === undefined || this.child !== child ? undefined : this.pending.get(id)
    if (request === undefined || id === undefined) return
    this.pending.delete(id)
    this.settled()
    request.resolve(message)
  }

  private settled(): void {
    if (this.pending.size > 0 || this.child === undefined) return
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.retire(`${this.upstream.name} stopped.`), this.timing.idleMs ?? IDLE_MS)
    this.idle.unref()
  }

  /** Lets go of the process before signalling it, so new work starts a fresh one instead of entering a dying one. */
  private retire(reason: string): void {
    const child = this.child
    this.detach()
    const error = new Error(reason)
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    if (child !== undefined) void terminateCliTree(child)
  }

  private detach(): void {
    clearTimeout(this.idle)
    this.child = undefined
    this.ready = undefined
  }

  private write(child: ChildProcess, message: JsonRecord): void {
    if (child.stdin?.writable === true) child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}

/**
 * The shared stdio upstreams, one per row. A row whose command, arguments or secrets
 * change gets a new process; the old one finishes its turns' calls and idles out, and
 * the pool forgets it, so a replaced secret is not kept here.
 */
export class StdioPool {
  private readonly upstreams = new Map<string, { key: string; pooled: PooledStdio }>()
  private closed = false

  constructor(private readonly timing: { idleMs?: number; startMs?: number; callMs?: number } = {}) {}

  /** `secretEnv` holds the row's own keys; nothing else of the server's env reaches the child. */
  lease(serverId: string, upstream: EffectProxyUpstream, secretEnv: Readonly<Record<string, string>>): PooledStdio {
    if (this.closed) throw new Error('Manor is shutting down.')
    const env = upstreamProcessEnv(process.env)
    for (const key of upstream.envKeys) {
      const value = secretEnv[key]
      if (value !== undefined) env[key] = value
    }
    const key = createHash('sha256')
      .update(JSON.stringify([upstream.command, upstream.args, upstream.envKeys.map((name) => [name, env[name] ?? ''])]))
      .digest('hex')
    const known = this.upstreams.get(serverId)
    if (known?.key === key) return known.pooled
    const pooled = new PooledStdio(upstream, env, this.timing)
    this.upstreams.set(serverId, { key, pooled })
    return pooled
  }

  /** Final. A replaced upstream still serving a turn is reaped with the other CLI children at shutdown. */
  close(): void {
    this.closed = true
    for (const { pooled } of this.upstreams.values()) pooled.close()
    this.upstreams.clear()
  }
}

/**
 * One turn's view of a shared upstream: the same gate the stdio proxy kept, so tool
 * calls run one after another and each passes the broker with this turn's capability
 * before the shared process sees it. A call the client cancels, or whose turn closes,
 * is dropped before the broker or before the upstream if it has not reached them yet;
 * once forwarded, the upstream is told and its answer is discarded, as the per-turn
 * proxy did.
 */
export function stdioConnectorEndpoint(pooled: PooledStdio, brokerUrl: string): McpEndpoint {
  let queue: Promise<unknown> = Promise.resolve()
  const running = new Map<unknown, AbortController>()
  const reply = (id: unknown, upstream: JsonRecord): JsonRecord => ({
    jsonrpc: '2.0',
    id,
    ...(upstream.error !== undefined ? { error: upstream.error } : { result: upstream.result ?? {} }),
  })
  const failed = (id: unknown, error: unknown): JsonRecord => ({
    jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : `${pooled.upstream.name} failed.` },
  })

  return async (message, capability, closed) => {
    const id = message.id
    if (id === undefined || id === null) {
      // The client gave up on a call; the shared upstream learns it under its own id.
      if (message.method === 'notifications/cancelled' && isRecord(message.params)) running.get(message.params.requestId)?.abort()
      return undefined
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    const cancel = new AbortController()
    running.set(id, cancel)
    const stop = AbortSignal.any([closed, cancel.signal])
    try {
      if (message.method === 'initialize') {
        try {
          const result = await pooled.initialize(stop)
          const params = isRecord(message.params) ? message.params : {}
          const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
          return { jsonrpc: '2.0', id, result: { ...result, protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : '2024-11-05' } }
        } catch (error: unknown) {
          return failed(id, error)
        }
      }
      const tool = toolCallName(message)
      const method = typeof message.method === 'string' ? message.method : ''
      const forward = async (): Promise<JsonRecord> => {
        try {
          return reply(id, await pooled.request(method, message.params, stop))
        } catch (error: unknown) {
          return tool === undefined ? failed(id, error) : deniedResult(id, error instanceof Error ? error.message : TURN_ENDED)
        }
      }
      if (tool === undefined) return await forward()

      const call = queue.then(async (): Promise<JsonRecord> => {
        if (stop.aborted) return deniedResult(id, TURN_ENDED)
        try {
          if (tool.length === 0) throw new Error('MCP tools/call had no tool name.')
          const args = isRecord(message.params) ? message.params.arguments : undefined
          await authorize(brokerUrl, capability, pooled.upstream.name, tool, args)
        } catch (error: unknown) {
          return deniedResult(id, error instanceof Error ? error.message : 'Connector call denied.')
        }
        if (stop.aborted) return deniedResult(id, TURN_ENDED)
        return forward()
      })
      queue = call
      return await call
    } finally {
      running.delete(id)
    }
  }
}
