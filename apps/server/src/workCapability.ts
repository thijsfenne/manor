import { randomBytes } from 'node:crypto'
import { rekeyEntry, type RekeyResult } from './capabilityRekey.js'
import type { WorkToolContext } from './workTool.js'

// Eight assignments can each be attempted three times within one bounded turn.
const MAX_WORK_CALLS = 24

interface WorkCapability extends WorkToolContext {
  calls: number
}

export class InvalidWorkCapabilityError extends Error {}

/** Bounds all assignment creation attempts and retries within one source turn. */
export class WorkCapabilities {
  private readonly entries = new Map<string, WorkCapability>()

  issue(context: WorkToolContext, token = randomBytes(32).toString('hex')): string {
    this.entries.set(token, { ...context, calls: 0 })
    return token
  }

  take(token: string | undefined): WorkToolContext {
    if (token === undefined || token === '') throw new InvalidWorkCapabilityError()
    const held = this.entries.get(token)
    if (held === undefined) {
      this.entries.delete(token)
      throw new InvalidWorkCapabilityError()
    }
    if (held.calls >= MAX_WORK_CALLS) throw new Error('Session handoff retry budget exhausted.')
    held.calls += 1
    return { chatId: held.chatId, agentId: held.agentId, turnId: held.turnId, ...(held.noProposal === true ? { noProposal: true as const } : {}) }
  }

  /** Moves this capability to a token a live process holds; see `rekeyEntry`. */
  rekey(from: string, to: string): RekeyResult {
    return rekeyEntry(this.entries, from, to)
  }

  closeTurn(turnId: string): void {
    for (const [token, held] of this.entries) {
      if (held.turnId === turnId) this.entries.delete(token)
    }
  }
}
