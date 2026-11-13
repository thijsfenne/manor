import { randomBytes } from 'node:crypto'
import { rekeyEntry, type RekeyResult } from './capabilityRekey.js'
import type { BrowserActor } from './browserBroker.js'

interface BrowserCapability {
  chatId: string
  /** The broker session driven; the chat id unless a browser session shares the home tabs. */
  sessionId: string
  actor: BrowserActor
  turnId: string
  canApprove: boolean
  /** False for unattended turns and background wakes: nobody may be there to approve a sign-in. */
  canFillLogin: boolean
}

export class InvalidBrowserCapabilityError extends Error {}

/**
 * A browser attachment gets one opaque capability. The provider CLI
 * can see its own child environment, so secrecy alone is not the boundary: the
 * server fixes the chat and actor here. There is no call budget; Stop and the end of the turn revoke it.
 */
export class BrowserCapabilities {
  private readonly entries = new Map<string, BrowserCapability>()

  issue(
    chatId: string,
    actor: BrowserActor,
    token = randomBytes(32).toString('hex'),
    approval: { turnId?: string; canApprove?: boolean; canFillLogin?: boolean; sessionId?: string } = {},
  ): string {
    this.entries.set(token, {
      chatId,
      sessionId: approval.sessionId ?? chatId,
      actor,
      turnId: approval.turnId ?? 'browser_turn',
      canApprove: approval.canApprove ?? true,
      canFillLogin: approval.canFillLogin ?? approval.canApprove ?? true,
    })
    return token
  }

  take(token: string | undefined): {
    chatId: string
    sessionId: string
    actor: BrowserActor
    turnId: string
    canApprove: boolean
    canFillLogin: boolean
  } {
    const capability = this.assertActive(token)
    return {
      chatId: capability.chatId,
      sessionId: capability.sessionId,
      actor: capability.actor,
      turnId: capability.turnId,
      canApprove: capability.canApprove,
      canFillLogin: capability.canFillLogin,
    }
  }

  /** Revalidate after a queued approval without spending a second logical call. */
  assertActive(token: string | undefined): BrowserCapability {
    if (token === undefined || token === '') throw new InvalidBrowserCapabilityError('Invalid or expired browser capability.')
    const capability = this.entries.get(token)
    if (capability === undefined) {
      this.entries.delete(token)
      throw new InvalidBrowserCapabilityError('Invalid or expired browser capability.')
    }
    return capability
  }

  /** The browser this turn holds, for a secret card that fills the page it is on. */
  forTurn(turnId: string): BrowserCapability | undefined {
    for (const capability of this.entries.values()) {
      if (capability.turnId === turnId) return capability
    }
    return undefined
  }

  /** Moves this capability to a token a live process holds; see `rekeyEntry`. */
  rekey(from: string, to: string): RekeyResult {
    return rekeyEntry(this.entries, from, to)
  }

  /** A terminal turn cannot keep driving the shared page through a lingering child. */
  closeTurn(turnId: string): void {
    for (const [token, capability] of this.entries) {
      if (capability.turnId === turnId) this.entries.delete(token)
    }
  }
}
