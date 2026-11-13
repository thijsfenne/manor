import { randomBytes } from 'node:crypto'
import { rekeyEntry, type RekeyResult } from './capabilityRekey.js'
import type { RoutineToolContext, RoutineToolName } from './routineTool.js'

export const ROUTINE_TOOL_CALL_LIMIT = 6

interface RoutineCapability extends RoutineToolContext {
  calls: number
}

export class InvalidRoutineCapabilityError extends Error {}

/** A turn-scoped budget, valid until `closeTurn`, fixes routine mutations to one persona's current DM turn. */
export class RoutineCapabilities {
  private readonly entries = new Map<string, RoutineCapability>()

  issue(context: RoutineToolContext, token = randomBytes(32).toString('hex')): string {
    this.entries.set(token, { ...context, calls: 0 })
    return token
  }

  take(token: string | undefined, _tool: RoutineToolName): RoutineToolContext {
    if (token === undefined || token === '') throw new InvalidRoutineCapabilityError()
    const capability = this.entries.get(token)
    if (capability === undefined) {
      this.entries.delete(token)
      throw new InvalidRoutineCapabilityError()
    }
    if (capability.calls >= ROUTINE_TOOL_CALL_LIMIT) {
      throw new Error(`Routine tool budget exhausted after ${ROUTINE_TOOL_CALL_LIMIT} calls.`)
    }
    capability.calls += 1
    return {
      chatId: capability.chatId,
      agentId: capability.agentId,
      turnId: capability.turnId,
    }
  }

  /** Moves this capability to a token a live process holds; see `rekeyEntry`. */
  rekey(from: string, to: string): RekeyResult {
    return rekeyEntry(this.entries, from, to)
  }

  closeTurn(turnId: string): void {
    for (const [token, capability] of this.entries) {
      if (capability.turnId === turnId) this.entries.delete(token)
    }
  }
}
