import { describe, expect, it } from 'vitest'
import {
  InvalidUserInputCapabilityError,
  OUTBOUND_DRAFT_CALL_LIMIT,
  USER_INPUT_CALL_LIMIT,
  UserInputCapabilities,
} from '../src/interactionCapability.js'
import { rekeyAcross } from '../src/capabilityRekey.js'

const context = { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1' }

describe('UserInputCapabilities', () => {
  it('stays usable until its turn closes', () => {
    const capabilities = new UserInputCapabilities()
    const token = capabilities.issue(context, 'long-turn')
    expect(capabilities.take(token)).toEqual(context)
    capabilities.closeTurn(context.turnId)
    expect(() => capabilities.take(token)).toThrow(InvalidUserInputCapabilityError)
  })

  it('moves a turn onto the token a live process holds, never over a live one', () => {
    const capabilities = new UserInputCapabilities()
    const held = capabilities.issue(context, 'held')
    const next = { ...context, turnId: 'turn_2' }
    capabilities.issue(next, 'fresh')
    expect(capabilities.rekey('fresh', 'held')).toBe('conflict')
    capabilities.closeTurn(context.turnId)
    expect(rekeyAcross([capabilities], 'fresh', held)).toBe('rekeyed')
    expect(capabilities.take(held)).toEqual(next)
    expect(() => capabilities.take('fresh')).toThrow(InvalidUserInputCapabilityError)
    expect(capabilities.rekey('oauth-token', held)).toBe('unknown')
    capabilities.closeTurn(next.turnId)
    expect(() => capabilities.take(held)).toThrow(InvalidUserInputCapabilityError)
  })

  it('binds chat, persona and turn to the issued token instead of caller input', () => {
    const capabilities = new UserInputCapabilities()
    const token = capabilities.issue(context, 'turn-token')

    expect(capabilities.take(token)).toEqual(context)
  })

  it('enforces the four-call budget at the broker boundary', () => {
    const capabilities = new UserInputCapabilities()
    const token = capabilities.issue(context, 'turn-token')

    for (let call = 0; call < USER_INPUT_CALL_LIMIT; call += 1) capabilities.take(token)
    expect(() => capabilities.take(token)).toThrow(`exhausted after ${USER_INPUT_CALL_LIMIT} questions`)
  })

  it('keeps a separate larger budget for a routine that prepares many drafts', () => {
    const capabilities = new UserInputCapabilities()
    const token = capabilities.issue(context, 'turn-token')

    for (let call = 0; call < OUTBOUND_DRAFT_CALL_LIMIT; call += 1) capabilities.take(token, 'draft')
    expect(() => capabilities.take(token, 'draft')).toThrow(
      `exhausted after ${OUTBOUND_DRAFT_CALL_LIMIT} drafts`,
    )
    expect(capabilities.take(token)).toEqual(context)
  })

  it('returns relay provenance without spending the ask-user budget', () => {
    const capabilities = new UserInputCapabilities()
    const relayContext = {
      ...context,
      canApprove: false,
      relay: { originChatId: 'dm_1', originTurnId: 'root_1', depth: 1, parentAgentId: 'marlow' },
    }
    const token = capabilities.issue(relayContext, 'relay-token')

    for (let call = 0; call < 8; call += 1) expect(capabilities.take(token, 'relay')).toEqual(relayContext)
    for (let call = 0; call < USER_INPUT_CALL_LIMIT; call += 1) capabilities.take(token)
    expect(() => capabilities.take(token)).toThrow(`exhausted after ${USER_INPUT_CALL_LIMIT} questions`)

    capabilities.closeTurn(context.turnId)
    expect(() => capabilities.take(token, 'relay')).toThrow(InvalidUserInputCapabilityError)
  })

  it('refuses empty and unknown capabilities', () => {
    const capabilities = new UserInputCapabilities()

    expect(() => capabilities.take('somebody-else')).toThrow(InvalidUserInputCapabilityError)
    expect(() => capabilities.take(undefined)).toThrow(InvalidUserInputCapabilityError)
    expect(() => capabilities.take('')).toThrow(InvalidUserInputCapabilityError)
  })
})
