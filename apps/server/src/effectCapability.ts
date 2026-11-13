import { randomBytes } from 'node:crypto'
import { rekeyEntry, type RekeyResult } from './capabilityRekey.js'
import type { McpServerConfig } from '@manor/contracts'
import type { UserInputContext } from './interactionCapability.js'
import { effectReviewArguments } from './effectReviewInput.js'
import { composioActionBatch, connectorEffect, executorAppAccess, type ConnectorEffect } from './effectPolicy.js'
import { EFFECT_CALL_LIMIT, type EffectBroker } from './effectBroker.js'
import { desktopRefusal, drivesDesktop } from './computerPolicy.js'
import type { DesktopLease } from './desktopLease.js'

export interface EffectContext extends UserInputContext {
  /** False for unattended routine runs: no approval surface means deny, never wait. */
  canApprove: boolean
  /** Agent-to-agent consultations may read connectors but never change external state. */
  readOnly?: boolean
}

export interface EffectRequest extends EffectContext {
  /** Set only after validating a proxy-private continuation permit. */
  continuedExecution?: true
  /** Set by the server for the first computer write of a turn: approval grants the desktop lease. */
  desktopLease?: true
  connector: { id: string; name: string }
  tool: string
  effect: ConnectorEffect
  /** Sanitised logical actions for a multiplexed connector; never call arguments. */
  actions?: string[]
  /** Present for every multiplexed router call and derived from its actual array. */
  actionCount?: number
  /** Ephemeral, bounded call input for Auto; never recorded in approval events. */
  reviewArguments?: unknown
  /** Server-owned lazy browser context, captured only when Auto actually reviews. */
  loadReviewArguments?: () => Promise<unknown>
}

interface Capability extends EffectContext {
  server: McpServerConfig
  env: Record<string, string>
  executions?: Map<string, { origin: string; remaining: number; executionId?: string }>
}

export interface ExecutorContinuation {
  permit: string
  executionId: string
  interaction: unknown
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export class InvalidEffectCapabilityError extends Error {}
export class InvalidEffectRequestError extends Error {}

/** A turn-scoped token fixes connector policy outside provider-controlled arguments. */
export class EffectCapabilities {
  private readonly entries = new Map<string, Capability>()

  constructor(
    private readonly desktop?: Pick<DesktopLease, 'admit' | 'covers' | 'grant' | 'ready'>,
  ) {}

  issue(
    context: EffectContext,
    server: McpServerConfig,
    token = randomBytes(32).toString('hex'),
    env: Record<string, string> = {},
  ): string {
    this.entries.set(token, { ...context, server, env: { ...env } })
    return token
  }

  /** One-shot connector secrets for the effect proxy. The capability itself stays. */
  takeEnv(token: string | undefined): Record<string, string> {
    if (token === undefined || token === '') throw new InvalidEffectCapabilityError()
    const capability = this.entries.get(token)
    if (capability === undefined) {
      this.entries.delete(token)
      throw new InvalidEffectCapabilityError()
    }
    const env = capability.env
    capability.env = {}
    return env
  }

  /** Who holds this capability and for which row, for a connect card. Uses no budget. */
  holder(token: string | undefined): { context: EffectContext; server: McpServerConfig } {
    const capability = token === undefined || token === '' ? undefined : this.entries.get(token)
    if (capability === undefined) throw new InvalidEffectCapabilityError()
    const { server, env: _env, executions: _executions, ...context } = capability
    return { context, server }
  }

  take(token: string | undefined, tool: string, arguments_: unknown = undefined, reviewInput: unknown = undefined): EffectRequest {
    if (token === undefined || token === '' || tool.length === 0 || tool.length > 300) {
      throw new InvalidEffectCapabilityError()
    }
    const capability = this.entries.get(token)
    if (capability === undefined) {
      this.entries.delete(token)
      throw new InvalidEffectCapabilityError()
    }
    const isComposioRouter = capability.server.name === 'composio' && tool === 'COMPOSIO_MULTI_EXECUTE_TOOL'
    const batch = isComposioRouter ? composioActionBatch(arguments_) : undefined
    if (isComposioRouter && batch === undefined) {
      throw new InvalidEffectRequestError('Malformed or oversized Composio batch was blocked before approval.')
    }
    let reviewArguments = capability.server.tools.includes(tool) ? effectReviewArguments(reviewInput) : undefined
    if (batch !== undefined && JSON.stringify(composioActionBatch(reviewArguments)?.actions) !== JSON.stringify(batch.actions)) {
      reviewArguments = undefined
    }
    return {
      ...(reviewArguments === undefined ? {} : { reviewArguments }),
      chatId: capability.chatId,
      agentId: capability.agentId,
      turnId: capability.turnId,
      canApprove: capability.canApprove,
      ...(capability.readOnly === undefined ? {} : { readOnly: capability.readOnly }),
      connector: { id: capability.server.id, name: capability.server.name },
      tool,
      effect: connectorEffect(capability.server, tool, arguments_),
      ...(batch === undefined ? {} : batch),
    }
  }

  /** The permit never enters a tool result, CLI env or transcript: only this proxy
   * receives it, after approval of the complete script. A new execute needs a new approval. */
  async authorize(token: string | undefined, call: {
    tool: string; arguments?: unknown; reviewArguments?: unknown; continuation?: unknown
  }, broker: Pick<EffectBroker, 'authorize'>): Promise<string | undefined> {
    const effect = this.take(token, call.tool, call.arguments, call.reviewArguments)
    const capability = this.entries.get(token!)!
    const review = effect.reviewArguments
    const continuation = call.continuation
    if (continuation !== undefined) {
      const grant = record(continuation) && typeof continuation.permit === 'string'
        ? capability.executions?.get(continuation.permit) : undefined
      if (capability.server.name !== 'executor' || call.tool !== 'resume' || !grant || grant.remaining < 1 ||
        !record(continuation) || typeof continuation.executionId !== 'string' ||
        (grant.executionId !== undefined && grant.executionId !== continuation.executionId) ||
        !record(review) || JSON.stringify(review.origin) !== grant.origin ||
        !record(review.input) || review.input.executionId !== continuation.executionId ||
        review.input.action !== 'accept' || review.input.content !== '{}' ||
        Object.keys(review.input).some((key) => !['executionId', 'action', 'content'].includes(key)) ||
        !executorAppAccess(continuation.interaction) ||
        JSON.stringify(review.interaction) !== JSON.stringify(continuation.interaction)) {
        throw new InvalidEffectRequestError('Invalid Executor continuation.')
      }
      grant.executionId = continuation.executionId
      grant.remaining -= 1
      effect.continuedExecution = true
    }
    const desktop = drivesDesktop(capability.server.name) ? this.desktop : undefined
    if (drivesDesktop(capability.server.name)) {
      if (desktop === undefined) throw new InvalidEffectRequestError('Computer use is not available on this host.')
      const refusal = desktopRefusal(capability.server.name, call.tool, call.arguments)
      if (refusal !== undefined) throw new InvalidEffectRequestError(refusal)
      // A call racing the first one waits for the same Escape confirmation.
      if (desktop.admit(effect.turnId) === 'held') await desktop.ready(effect.turnId)
      // One Escape for the turn, but Cua's and the Codex engine's scopes differ, so each asks once.
      if (effect.effect === 'confirm_write') {
        if (desktop.covers(effect.turnId, capability.server.name)) effect.effect = 'trusted_write'
        else effect.desktopLease = true
      }
    }
    await broker.authorize(effect)
    if (this.entries.get(token!) !== capability) {
      throw new InvalidEffectCapabilityError()
    }
    // The action runs only once the desktop host has confirmed Escape is registered.
    if (effect.desktopLease === true) await desktop?.grant(effect.turnId, effect.agentId, capability.server.name)
    if (capability.server.name !== 'executor' || call.tool !== 'execute' ||
      !record(review) || !record(review.input) || typeof review.input.code !== 'string') return undefined
    const executions = capability.executions ??= new Map()
    if (executions.size >= EFFECT_CALL_LIMIT) return undefined
    const permit = randomBytes(32).toString('hex')
    executions.set(permit, { origin: JSON.stringify(review.input), remaining: 3 })
    return permit
  }

  /** Moves this capability to a token a live process holds; see `rekeyEntry`. */
  rekey(from: string, to: string): RekeyResult {
    return rekeyEntry(this.entries, from, to)
  }

  /** A provider process may linger; terminal turns revoke every connector token. */
  closeTurn(turnId: string): void {
    for (const [token, capability] of this.entries) {
      if (capability.turnId === turnId) this.entries.delete(token)
    }
  }
}
