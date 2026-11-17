import type { ReviewEffect } from './effectReviewer.js'
import type { EffectRequest } from './effectCapability.js'
import type { InteractionBroker } from './interactionBroker.js'
import { CODEX_COMPUTER_MCP_NAME, COMPUTER_CALL_LIMIT, drivesDesktop } from './computerPolicy.js'
import { approvalQuestion, humanOnlyChoices, humanOnlyWrite } from './effectPolicy.js'

const APPROVAL_ID = 'allow_effect'
const ALLOW_ONCE = 'Allow once'
export const EFFECT_CALL_LIMIT = 60
export const EFFECT_APPROVAL_LIMIT = 3

export class EffectApprovalDeniedError extends Error {}
/** The user answered the card with its deny choice, as opposed to a call blocked without asking. */
export class EffectDeclinedError extends EffectApprovalDeniedError {}
export class EffectBudgetExceededError extends Error {}

interface TurnEffectUsage {
  calls: number
  computerCalls: number
  approvals: number
  denied: boolean
  controller: AbortController
}

/** The one server-owned decision point every guarded connector effect crosses. */
export class EffectBroker {
  private readonly usage = new Map<string, TurnEffectUsage>()

  constructor(
    private readonly interactions: Pick<InteractionBroker, 'request'>,
    private readonly review?: ReviewEffect,
    private readonly fullAccess = false,
  ) {}

  async authorize(request: EffectRequest, options: {
    waitForHuman?: (ask: () => Promise<void>) => Promise<void>
  } = {}): Promise<void> {
    const usage = this.consume(request)
    if (
      request.readOnly === true &&
      (request.effect === 'trusted_write' || request.effect === 'confirm_write')
    ) {
      throw new EffectApprovalDeniedError(
        `${request.connector.name}.${request.tool} was blocked before it ran: agent-to-agent consultations are read-only.`,
      )
    }
    if (request.effect !== 'confirm_write') return
    if (!request.canApprove) {
      throw new EffectApprovalDeniedError(
        `${request.connector.name}.${request.tool} was blocked before it ran: this unattended turn has no approval surface.`,
      )
    }

    const humanOnly = humanOnlyWrite(request.connector.name, request.tool)
    if (this.fullAccess && !humanOnly) return

    // The same script was already approved. Only a capability-validated empty
    // Computer Use app-access continuation can carry this server-owned flag.
    if (request.continuedExecution === true && !usage.denied && !humanOnly) return

    // The desktop lease covers every later write of the turn, so no single-call
    // reviewer may grant it on the strength of one click.
    if (this.review !== undefined && !usage.denied && request.desktopLease !== true && !humanOnly) {
      const allowed = await this.review(request, usage.controller.signal).catch(() => false)
      if (usage.controller.signal.aborted) {
        throw new EffectApprovalDeniedError('The turn ended before the action was approved.')
      }
      if (allowed && !usage.denied) return
    }
    let previewQuestion: string | undefined
    try {
      previewQuestion = approvalQuestion(request.connector.name, request.tool, request.reviewArguments)
    } catch (error: unknown) {
      throw new EffectApprovalDeniedError(
        `${request.connector.name}.${request.tool} was blocked before it ran: ${
          error instanceof Error ? error.message : 'its arguments could not be shown for approval.'
        }`,
      )
    }
    const action = effectLabel(request)
    const choices = humanOnlyChoices(request.connector.name, request.tool)
    const allowLabel = choices?.allow.label ?? ALLOW_ONCE
    const ask = () => {
      if (usage.controller.signal.aborted) {
        throw new EffectApprovalDeniedError('The turn ended before the action was approved.')
      }
      if (usage.approvals >= EFFECT_APPROVAL_LIMIT) {
        throw new EffectBudgetExceededError(
          `Approval budget exhausted after ${EFFECT_APPROVAL_LIMIT} requests in this turn.`,
        )
      }
      usage.approvals += 1
      return this.interactions.request({
        chatId: request.chatId, agentId: request.agentId, turnId: request.turnId,
      }, [{
        id: APPROVAL_ID,
        header: request.connector.name,
        question: previewQuestion ?? (request.desktopLease === true
          ? 'Let this agent use your Mac for the rest of this turn? Press Escape to stop it.'
          : `${action} may change external state. Allow this call?`),
        optionsOnly: true,
        ...(choices?.desktopOnly === true ? { desktopOnly: true } : {}),
        options: choices !== undefined ? [choices.allow, choices.deny] : [
          { label: ALLOW_ONCE, description: request.desktopLease === true
            ? request.connector.name === CODEX_COMPUTER_MCP_NAME
              ? 'Approves its scripts until this turn ends. They click and type in the background, and can also read files and run commands on this Mac.'
              : 'Approves its clicks and typing until this turn ends. It works in the background, but an app that ignores that, such as a canvas, is briefly brought to the front and your cursor moves.'
            : request.connector.name === 'executor' && request.tool === 'execute'
            ? 'Approve this script, including up to three Computer Use app-access prompts with empty forms. New scripts and other forms ask again.'
            : 'Run this call once, then ask again for the next write.' },
          { label: 'Deny', description: 'Block it before the connector receives anything.' },
        ],
      }])
    }

    const wait = async () => {
      const answers = await ask()
      if (!usage.controller.signal.aborted && answers[APPROVAL_ID] === allowLabel) return
      usage.denied = true
      const Denied = usage.controller.signal.aborted ? EffectApprovalDeniedError : EffectDeclinedError
      throw new Denied(
        `${request.connector.name}.${request.tool} was denied before it ran. Do not retry without new user direction.`,
      )
    }
    if (options.waitForHuman === undefined) await wait()
    else await options.waitForHuman(wait)
    if (usage.controller.signal.aborted) {
      throw new EffectApprovalDeniedError('The turn ended before the action was approved.')
    }
  }

  /** Terminal turns lose both their budget and any history that could grow forever. */
  closeTurn(turnId: string): void {
    this.usage.get(turnId)?.controller.abort()
    this.usage.delete(turnId)
  }

  private consume(request: EffectRequest): TurnEffectUsage {
    const current = this.usage.get(request.turnId) ??
      { calls: 0, computerCalls: 0, approvals: 0, denied: false, controller: new AbortController() }
    const calls = request.actionCount ?? 1
    if (
      !Number.isInteger(calls) ||
      calls < 1 ||
      (request.actionCount !== undefined && request.actions?.length !== request.actionCount)
    ) {
      throw new EffectBudgetExceededError('Invalid effect call count.')
    }
    if (drivesDesktop(request.connector.name)) {
      if (current.computerCalls + calls > COMPUTER_CALL_LIMIT) {
        throw new EffectBudgetExceededError(
          `Computer budget exhausted after ${COMPUTER_CALL_LIMIT} calls in this turn.`,
        )
      }
      current.computerCalls += calls
      this.usage.set(request.turnId, current)
      return current
    }
    if (current.calls + calls > EFFECT_CALL_LIMIT) {
      throw new EffectBudgetExceededError(
        `Effect budget exhausted after ${EFFECT_CALL_LIMIT} calls in this turn.`,
      )
    }
    current.calls += calls
    this.usage.set(request.turnId, current)
    return current
  }
}

function effectLabel(request: EffectRequest): string {
  const actions = request.actions
  if (actions === undefined || actions.length === 0) return `${request.connector.name}.${request.tool}`
  const visible = actions.slice(0, 3).join(', ')
  return actions.length <= 3 ? visible : `${visible} and ${actions.length - 3} more actions`
}
