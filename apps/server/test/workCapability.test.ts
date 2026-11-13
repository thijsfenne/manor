import { describe, expect, it } from 'vitest'
import { InvalidWorkCapabilityError, WorkCapabilities } from '../src/workCapability.js'

const context = { chatId: 'dm_1', agentId: 'sage', turnId: 'turn_1' }

describe('WorkCapabilities', () => {
  it('stays usable until its turn closes', () => {
    const capabilities = new WorkCapabilities()
    const token = capabilities.issue(context, 'long-turn')
    expect(capabilities.take(token)).toEqual(context)
    capabilities.closeTurn(context.turnId)
    expect(() => capabilities.take(token)).toThrow(InvalidWorkCapabilityError)
  })

  it('binds the source chat, lead and turn outside model input', () => {
    const capabilities = new WorkCapabilities()
    const token = capabilities.issue(context, 'turn-token')

    expect(capabilities.take(token)).toEqual(context)
  })

  it('allows bounded provider retries but not another unbounded write surface', () => {
    const capabilities = new WorkCapabilities()
    const token = capabilities.issue(context, 'turn-token')

    // Three distinct assignments plus a retry of a failed sibling must fit.
    for (let call = 0; call < 4; call += 1) expect(capabilities.take(token)).toEqual(context)
    // Retain a hard cap even if a provider keeps attempting new keys.
    for (let call = 4; call < 24; call += 1) expect(capabilities.take(token)).toEqual(context)
    expect(() => capabilities.take(token)).toThrow('Session handoff retry budget exhausted.')
  })

  it('refuses empty and unknown capabilities', () => {
    const capabilities = new WorkCapabilities()

    expect(() => capabilities.take('somebody-else')).toThrow(InvalidWorkCapabilityError)
    expect(() => capabilities.take(undefined)).toThrow(InvalidWorkCapabilityError)
  })
})
