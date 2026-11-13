import { randomUUID } from 'node:crypto'
import { effectReviewArguments } from '../effectReviewInput.js'
import { composioActionBatch } from '../effectPolicy.js'
import type { ExecutorContinuation } from '../effectCapability.js'
import type { EffectProxyUpstream } from './effectProxyAttachment.js'
import { ExecutorSession } from './executorSession.js'
import { COMPOSIO_MANAGE_CONNECTIONS_TOOL, COMPOSIO_MCP_NAME } from './composioAttachment.js'
import {
  composioConnectLinks,
  connectCardResult,
  unaliasedComposioAdd,
  type ComposioConnectLink,
  type ConnectOutcome,
} from './connectLinks.js'
import { TURN_ENDED, isRecord, type JsonRecord } from './stdio.js'

const UPSTREAM_PROTOCOL_VERSION = '2025-06-18'

const initializedBy = (replies: unknown[], id: unknown): boolean =>
  replies.some((reply) => isRecord(reply) && reply.id === id && isRecord(reply.result))

/**
 * The effect broker as a connector transport sees it: one loopback route, the
 * capability in a header. The stdio proxy and the Manor HTTP endpoint both call it,
 * so a call reaching an upstream either way meets the same policy and refusals.
 */
export async function takeBrokerEnv(brokerUrl: string, capability: string): Promise<NodeJS.ProcessEnv> {
  const response = await fetch(brokerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-manor-effect-capability': capability,
    },
    body: JSON.stringify({ env: true }),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (
    response.ok &&
    isRecord(payload) &&
    isRecord(payload.env) &&
    Object.values(payload.env).every((value) => typeof value === 'string')
  ) {
    return payload.env as NodeJS.ProcessEnv
  }
  return {}
}

export async function authorize(
  brokerUrl: string,
  capability: string,
  connector: string,
  tool: string,
  arguments_: unknown,
  reviewInput: unknown = arguments_,
  continuation?: ExecutorContinuation,
): Promise<string | undefined> {
  const classification = brokerArguments(connector, tool, arguments_)
  const response = await fetch(brokerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-manor-effect-capability': capability,
    },
    // Classification needs only slugs. Auto also receives bounded call input over
    // loopback; secret-bearing or oversized input falls back to a human approval.
    body: JSON.stringify({
      tool,
      ...(classification === undefined ? {} : { arguments: classification }),
      reviewArguments: effectReviewArguments(reviewInput),
      ...(continuation === undefined ? {} : { continuation }),
    }),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (response.ok && isRecord(payload) && payload.approved === true) {
    return typeof payload.continuation === 'string' ? payload.continuation : undefined
  }
  const message = isRecord(payload) && typeof payload.error === 'string'
    ? payload.error
    : `Effect broker returned HTTP ${response.status}.`
  throw new Error(message)
}

/**
 * Hands a sign-in to Manor as a connect card. A Composio card answers once it is
 * connected, failed, or the short hold ran out; an MCP login answers at once.
 */
async function requestConnect(
  brokerUrl: string,
  capability: string,
  connect: ({ kind: 'composio' } & ComposioConnectLink) | { kind: 'mcp_oauth' },
): Promise<ConnectOutcome> {
  const response = await fetch(brokerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-manor-effect-capability': capability },
    body: JSON.stringify({ connect }),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  const outcome = isRecord(payload) && isRecord(payload.outcome) ? payload.outcome : undefined
  if (outcome?.status === 'connected') return { status: 'connected' }
  if (outcome?.status === 'failed') {
    return { status: 'failed', reason: typeof outcome.reason === 'string' ? outcome.reason : 'Manor could not show the card.' }
  }
  if (response.ok) return { status: 'pending' }
  return { status: 'failed', reason: 'Manor could not show the connect card.' }
}

/** What the broker needs to classify a call: Composio slugs, or computer arguments for the background check. */
function brokerArguments(connector: string, tool: string, value: unknown): unknown {
  if (connector === 'computer') return isRecord(value) ? value : {}
  if (connector !== 'composio' || tool !== 'COMPOSIO_MULTI_EXECUTE_TOOL') return undefined
  const batch = composioActionBatch(value)
  if (batch === undefined) throw new Error('Malformed or oversized Composio batch was blocked before approval.')
  return {
    tools: batch.actions.map((tool_slug) => ({ tool_slug })),
  }
}

export const toolCallName = (message: JsonRecord): string | undefined => {
  if (message.method !== 'tools/call' || !isRecord(message.params)) return undefined
  return typeof message.params.name === 'string' ? message.params.name : ''
}

export const deniedResult = (id: unknown, message: string): JsonRecord => ({
  jsonrpc: '2.0',
  id,
  result: {
    isError: true,
    content: [{ type: 'text', text: message }],
  },
})

export function toolResult(message: unknown): JsonRecord {
  if (!isRecord(message) || !isRecord(message.result)) throw new Error('Executor returned no tool result.')
  return message.result
}

interface HttpSession {
  id: string | null
  protocolVersion: string | null
}

/**
 * One HTTP upstream for one turn's capability, gated call by call by the effect
 * broker. Messages are handled one at a time, in arrival order, as a stdio pipe would.
 */
export class HttpConnector {
  private readonly session: HttpSession = { id: null, protocolVersion: null }
  private readonly executor: ExecutorSession | undefined
  /** A remote row that needs a login asks once per turn, whichever message hit the 401. */
  private readonly asksLogin: boolean
  private loginRequested = false
  private secrets: Promise<NodeJS.ProcessEnv> | undefined
  private capability = ''
  private queue: Promise<unknown> = Promise.resolve()
  /** Whether the upstream saw an initialize from this connector. */
  private initialized = false

  /**
   * `emit` takes messages that answer none of the client's requests, such as an
   * Executor's interleaved notifications. `secretEnv` is the env a proxy already
   * took at startup; without it the first message takes it from the broker once.
   * Header and bearer values come only from there, never from the server's env.
   */
  constructor(
    private readonly upstream: EffectProxyUpstream,
    private readonly brokerUrl: string,
    private readonly emit: (message: unknown) => void,
    secretEnv?: NodeJS.ProcessEnv,
  ) {
    if (upstream.url === undefined) throw new Error('HTTP effect proxy has no upstream URL.')
    if (upstream.allowTools !== undefined) throw new Error('A tool allowlist needs a stdio upstream.')
    if (secretEnv !== undefined) this.secrets = Promise.resolve(secretEnv)
    this.asksLogin = Object.keys(upstream.httpHeaders).length === 0
    this.executor = upstream.name === 'executor' ? new ExecutorSession(
      (tool, args, review, continuation) => authorize(brokerUrl, this.capability, upstream.name, tool, args, review, continuation),
      async (tool, args) => {
        const id = `manor_${randomUUID()}`
        const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } })
        const messages = await this.forward(body)
        for (const message of messages) {
          if (!isRecord(message) || message.id !== id) this.emit(message)
        }
        return toolResult(messages.find((message) => isRecord(message) && message.id === id))
      },
    ) : undefined
  }

  /**
   * Every message to hand back for one client message, in order. `closed` aborts when
   * the call's turn ends: a call still queued then never runs, because a rekey may
   * already have given its capability to the next turn.
   */
  handle(message: JsonRecord, capability: string, closed?: AbortSignal): Promise<unknown[]> {
    const next = this.queue.then(() => {
      if (closed?.aborted === true) return message.id === undefined ? [] : [deniedResult(message.id, TURN_ENDED)]
      this.capability = capability
      return this.handleNow(message, closed)
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  private async handleNow(message: JsonRecord, closed?: AbortSignal): Promise<unknown[]> {
    const { upstream, brokerUrl, capability } = this
    const tool = toolCallName(message)
    const managesConnections = upstream.name === COMPOSIO_MCP_NAME && tool === COMPOSIO_MANAGE_CONNECTIONS_TOOL
    const callArguments = isRecord(message.params) ? message.params.arguments : undefined
    if (tool !== undefined) {
      try {
        if (tool.length === 0) throw new Error('MCP tools/call had no tool name.')
        const unaliased = managesConnections ? unaliasedComposioAdd(callArguments) : undefined
        if (unaliased !== undefined) {
          throw new Error(`Adding ${unaliased} needs the personal or work alias. Ask the user which account, then call again with that alias.`)
        }
        if (this.executor !== undefined && (tool === 'execute' || tool === 'resume')) {
          const result = await this.executor.run(tool, callArguments)
          return [{ jsonrpc: '2.0', id: message.id, result }]
        }
        await authorize(brokerUrl, capability, upstream.name, tool, callArguments)
      } catch (error: unknown) {
        return [deniedResult(message.id, error instanceof Error ? error.message : 'Connector call denied.')]
      }
    }
    try {
      if (message.method !== 'initialize') await this.initializeUpstream()
      // The broker and the upstream session take time; a turn that ended meanwhile sends nothing.
      if (tool !== undefined && closed?.aborted === true) return [deniedResult(message.id, TURN_ENDED)]
      const returned = await this.forward(JSON.stringify(message))
      if (message.method === 'initialize' && initializedBy(returned, message.id)) this.initialized = true
      const replies: unknown[] = []
      for (const item of returned) {
        captureProtocol(this.session, item)
        replies.push(managesConnections && isRecord(item) && item.id === message.id
          ? await withConnectCards(item, callArguments, brokerUrl, capability)
          : item)
      }
      return replies
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'HTTP connector failed.'
      if (this.asksLogin && !this.loginRequested && detail === `${upstream.name} requires login.`) {
        this.loginRequested = true
        void requestConnect(brokerUrl, capability, { kind: 'mcp_oauth' }).catch(() => undefined)
      }
      return message.id === undefined ? [] : [{ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: detail } }]
    }
  }

  /**
   * A live Codex process initialized its MCP session in an earlier turn and keeps
   * sending calls; this turn's connector then opens its own upstream session first.
   */
  private async initializeUpstream(): Promise<void> {
    if (this.initialized) return
    const id = `manor_${randomUUID()}`
    const replies = await this.forward(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: {
      protocolVersion: UPSTREAM_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'manor', version: '0.1.0' },
    } }))
    if (!initializedBy(replies, id)) throw new Error(`${this.upstream.name} did not initialize.`)
    for (const item of replies) captureProtocol(this.session, item)
    await this.forward(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    this.initialized = true
  }

  private async forward(body: string): Promise<unknown[]> {
    this.secrets ??= takeBrokerEnv(this.brokerUrl, this.capability)
    return forwardHttp(this.upstream, this.session, body, await this.secrets)
  }
}

/** Swaps each Composio sign-in link in the reply for a card and tells the model what became of it. */
async function withConnectCards(
  reply: JsonRecord,
  args: unknown,
  brokerUrl: string,
  capability: string,
): Promise<JsonRecord> {
  if (!isRecord(reply.result)) return reply
  const links = composioConnectLinks(args, reply.result)
  if (links.length === 0) return reply
  const outcomes = await Promise.all(links.map((link) =>
    requestConnect(brokerUrl, capability, { kind: 'composio', ...link })
      .catch((): ConnectOutcome => ({ status: 'failed', reason: 'Manor could not show the connect card.' }))))
  return { ...reply, result: connectCardResult(reply.result, links, outcomes) }
}

async function forwardHttp(
  upstream: EffectProxyUpstream,
  session: HttpSession,
  body: string,
  secretEnv: NodeJS.ProcessEnv,
): Promise<unknown[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  for (const [name, envKey] of Object.entries(upstream.httpHeaders)) {
    const value = secretEnv[envKey]
    if (value === undefined || value.length === 0) throw new Error(`${upstream.name} is missing ${envKey}.`)
    headers[name] = value
  }
  if (upstream.bearerEnvKey !== undefined) {
    const bearer = secretEnv[upstream.bearerEnvKey]
    if (bearer === undefined || bearer.length === 0) throw new Error(`${upstream.name} is missing OAuth.`)
    headers.Authorization = `Bearer ${bearer}`
  }
  if (session.id !== null) headers['Mcp-Session-Id'] = session.id
  if (session.protocolVersion !== null) headers['MCP-Protocol-Version'] = session.protocolVersion

  const response = await fetch(upstream.url!, { method: 'POST', headers, body })
  if (response.status === 401) throw new Error(`${upstream.name} requires login.`)
  const nextSession = response.headers.get('mcp-session-id')
  if (nextSession !== null && nextSession.length > 0) session.id = nextSession
  const text = await response.text()
  if (!response.ok) throw new Error(`${upstream.name} answered HTTP ${response.status}.`)
  if (text.trim().length === 0) return []
  return parseHttpMessages(text, response.headers.get('content-type') ?? '')
}

function parseHttpMessages(text: string, contentType: string): unknown[] {
  if (!contentType.includes('text/event-stream') && !text.startsWith('event:') && !text.startsWith('data:')) {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  const messages: unknown[] = []
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (const block of normalized.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (data.length === 0 || data === '[DONE]') continue
    try {
      messages.push(JSON.parse(data) as unknown)
    } catch {
      continue
    }
  }
  if (messages.length === 0) throw new Error('HTTP MCP response contained no JSON.')
  return messages
}

function captureProtocol(session: HttpSession, message: unknown): void {
  if (!isRecord(message) || !isRecord(message.result)) return
  const version = message.result.protocolVersion
  if (typeof version === 'string' && version.length > 0) session.protocolVersion = version
}
