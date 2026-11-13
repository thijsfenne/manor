import { randomBytes } from 'node:crypto'
import { rekeyEntry, type RekeyResult } from './capabilityRekey.js'

export const USER_INPUT_CALL_LIMIT = 4
export const OUTBOUND_DRAFT_CALL_LIMIT = 50
/** Files one turn may hand over; the same eight a message may carry the other way. */
export const FILE_DELIVERY_CALL_LIMIT = 8

export interface UserInputContext {
  chatId: string
  agentId: string
  turnId: string
  /** False for unattended and relayed turns; only user-originated turns may approve. */
  canApprove?: boolean
  /** A project thread turn the user's own message started: only it may send to a Session. */
  mayForward?: true
  /** A project thread turn the user or a Session question started: only it may answer one. */
  mayAnswer?: true
  /** Where a secret card's command runs. Absent for a persona without a shell. */
  commandCwd?: string
  relay?: {
    originChatId: string
    originTurnId: string
    depth: number
    /** The persona who sent this turn here; the synchronous return path replaces a callback. */
    parentAgentId?: string
  }
}

interface Capability extends UserInputContext {
  askCalls: number
  draftCalls: number
  deliverCalls: number
}

export class InvalidUserInputCapabilityError extends Error {}

/** A turn-scoped token, valid until `closeTurn`, fixes the chat, persona and turn outside the model's input. */
export class UserInputCapabilities {
  private readonly entries = new Map<string, Capability>()

  issue(context: UserInputContext, token = randomBytes(32).toString('hex')): string {
    this.entries.set(token, { ...context, askCalls: 0, draftCalls: 0, deliverCalls: 0 })
    return token
  }

  take(token: string | undefined, use: 'ask' | 'draft' | 'relay' | 'subagent' | 'deliver' | 'goal' | 'project' = 'ask'): UserInputContext {
    if (token === undefined || token === '') throw new InvalidUserInputCapabilityError()
    const capability = this.entries.get(token)
    if (capability === undefined) {
      this.entries.delete(token)
      throw new InvalidUserInputCapabilityError()
    }
    if (use === 'ask' && capability.askCalls >= USER_INPUT_CALL_LIMIT) {
      throw new Error(`Ask-user budget exhausted after ${USER_INPUT_CALL_LIMIT} questions.`)
    }
    if (use === 'draft' && capability.draftCalls >= OUTBOUND_DRAFT_CALL_LIMIT) {
      throw new Error(`Outbound-draft budget exhausted after ${OUTBOUND_DRAFT_CALL_LIMIT} drafts.`)
    }
    if (use === 'deliver' && capability.deliverCalls >= FILE_DELIVERY_CALL_LIMIT) {
      throw new Error(`File-delivery budget exhausted after ${FILE_DELIVERY_CALL_LIMIT} files this turn.`)
    }
    if (use === 'ask') capability.askCalls += 1
    else if (use === 'draft') capability.draftCalls += 1
    else if (use === 'deliver') capability.deliverCalls += 1
    return {
      chatId: capability.chatId,
      agentId: capability.agentId,
      turnId: capability.turnId,
      ...(capability.canApprove === undefined ? {} : { canApprove: capability.canApprove }),
      ...(capability.mayForward === true ? { mayForward: true as const } : {}),
      ...(capability.mayAnswer === true ? { mayAnswer: true as const } : {}),
      ...(capability.commandCwd === undefined ? {} : { commandCwd: capability.commandCwd }),
      ...(capability.relay === undefined ? {} : { relay: { ...capability.relay } }),
    }
  }

  /** Moves this capability to a token a live process holds; see `rekeyEntry`. */
  rekey(from: string, to: string): RekeyResult {
    return rekeyEntry(this.entries, from, to)
  }

  /** A terminal turn revokes every interaction tool token it owned. */
  closeTurn(turnId: string): void {
    for (const [token, capability] of this.entries) {
      if (capability.turnId === turnId) this.entries.delete(token)
    }
  }
}
