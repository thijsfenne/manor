import { describe, expect, it } from 'vitest'
import {
  ArtifactCapabilities,
  ARTIFACT_SEARCH_CALL_LIMIT,
  ARTIFACT_VIEW_CALL_LIMIT,
  InvalidArtifactCapabilityError,
} from '../src/artifactCapability.js'

const context = { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1' }

describe('ArtifactCapabilities', () => {
  it('stays usable until its turn closes', () => {
    const capabilities = new ArtifactCapabilities()
    const token = capabilities.issue(context, 'long-turn')
    expect(capabilities.take(token, 'artifact_search')).toEqual(context)
    capabilities.closeTurn(context.turnId)
    expect(() => capabilities.take(token, 'artifact_view')).toThrow(InvalidArtifactCapabilityError)
  })

  it('binds a short-lived capability to one turn and applies separate credit budgets', () => {
    const capabilities = new ArtifactCapabilities()
    const token = capabilities.issue(context, 'artifact-token')

    for (let index = 0; index < ARTIFACT_SEARCH_CALL_LIMIT; index += 1) {
      expect(capabilities.take(token, 'artifact_search')).toEqual(context)
    }
    expect(() => capabilities.take(token, 'artifact_search')).toThrow('search budget exhausted')
    for (let index = 0; index < ARTIFACT_VIEW_CALL_LIMIT; index += 1) {
      expect(capabilities.take(token, 'artifact_view')).toEqual(context)
    }
    expect(() => capabilities.take(token, 'artifact_view')).toThrow('view budget exhausted')
  })

  it('hides missing capabilities behind the same invalid result', () => {
    const capabilities = new ArtifactCapabilities()

    expect(() => capabilities.take('unknown', 'artifact_search')).toThrow(InvalidArtifactCapabilityError)
  })
})
