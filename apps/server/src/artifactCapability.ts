import { randomBytes } from 'node:crypto'
import { rekeyEntry, type RekeyResult } from './capabilityRekey.js'
import type { ArtifactToolName } from './artifactBroker.js'

export const ARTIFACT_SEARCH_CALL_LIMIT = 3
export const ARTIFACT_VIEW_CALL_LIMIT = 4

export interface ArtifactToolContext {
  chatId: string
  agentId: string
  turnId: string
}

interface ArtifactCapability extends ArtifactToolContext {
  searches: number
  views: number
}

export class InvalidArtifactCapabilityError extends Error {}

/** A turn-scoped capability, valid until `closeTurn`, keeps mymind credentials and credit budgets server-side. */
export class ArtifactCapabilities {
  private readonly entries = new Map<string, ArtifactCapability>()

  issue(context: ArtifactToolContext, token = randomBytes(32).toString('hex')): string {
    this.entries.set(token, { ...context, searches: 0, views: 0 })
    return token
  }

  take(token: string | undefined, tool: ArtifactToolName): ArtifactToolContext {
    if (token === undefined || token === '') throw new InvalidArtifactCapabilityError()
    const capability = this.entries.get(token)
    if (capability === undefined) {
      this.entries.delete(token)
      throw new InvalidArtifactCapabilityError()
    }
    if (tool === 'artifact_search') {
      if (capability.searches >= ARTIFACT_SEARCH_CALL_LIMIT) {
        throw new Error(`Artifact search budget exhausted after ${ARTIFACT_SEARCH_CALL_LIMIT} searches.`)
      }
      capability.searches += 1
    } else {
      if (capability.views >= ARTIFACT_VIEW_CALL_LIMIT) {
        throw new Error(`Artifact view budget exhausted after ${ARTIFACT_VIEW_CALL_LIMIT} calls.`)
      }
      capability.views += 1
    }
    return { chatId: capability.chatId, agentId: capability.agentId, turnId: capability.turnId }
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
