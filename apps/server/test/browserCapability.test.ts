import { describe, expect, it } from 'vitest'
import { BrowserCapabilities } from '../src/browserCapability.js'

const sage = { id: 'sage', name: 'Sage' }

describe('BrowserCapabilities', () => {
  it('stays usable until its turn closes', () => {
    const capabilities = new BrowserCapabilities()
    const token = capabilities.issue('chat_1', sage, 'long-turn', { turnId: 'turn_1' })
    expect(capabilities.take(token).turnId).toBe('turn_1')
    capabilities.closeTurn('turn_1')
    expect(() => capabilities.take(token)).toThrow('Invalid or expired')
  })

  it('binds identity to the issued token instead of caller input', () => {
    const capabilities = new BrowserCapabilities()
    const token = capabilities.issue('chat_1', sage, 'turn-token')

    expect(capabilities.take(token)).toEqual({
      chatId: 'chat_1',
      sessionId: 'chat_1',
      actor: sage,
      turnId: 'browser_turn',
      canApprove: true,
      canFillLogin: true,
    })
  })

  it('keeps a saved-login fill off for a turn that may approve other actions, such as a wake', () => {
    const capabilities = new BrowserCapabilities()
    const token = capabilities.issue('chat_1', sage, 'wake-token', { canApprove: true, canFillLogin: false })
    expect(capabilities.take(token)).toMatchObject({ canApprove: true, canFillLogin: false })
  })

  it('does not cap the number of browser calls', () => {
    const capabilities = new BrowserCapabilities()
    const token = capabilities.issue('chat_1', sage, 'turn-token')

    for (let call = 0; call < 500; call += 1) capabilities.take(token)
    expect(() => capabilities.take(token)).not.toThrow()
  })

  it('refuses unknown capabilities', () => {
    const capabilities = new BrowserCapabilities()

    expect(() => capabilities.take('somebody-else')).toThrow('Invalid or expired')
  })

  it('revokes a lingering browser child when its turn ends', () => {
    const capabilities = new BrowserCapabilities()
    const token = capabilities.issue('chat_1', sage, 'turn-token', { turnId: 'turn_1' })
    capabilities.closeTurn('turn_1')
    expect(() => capabilities.take(token)).toThrow('Invalid or expired')
  })
  it('revalidates a queued approval without consuming extra browser calls', () => {
    const capabilities = new BrowserCapabilities()
    const token = capabilities.issue('chat_1', sage, 'turn-token', { turnId: 'turn_1' })
    for (let call = 0; call < 50; call += 1) capabilities.take(token)
    expect(() => capabilities.assertActive(token)).not.toThrow()
    capabilities.closeTurn('turn_1')
    expect(() => capabilities.assertActive(token)).toThrow('Invalid or expired')
  })

})
