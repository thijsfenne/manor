import { describe, expect, it } from 'vitest'

import { OPEN_SEND_LOCK, SENT_SEND_LOCK, sendWaitLine, settleSendLock } from './sendWait'

describe('sendWaitLine', () => {
  it('says nothing while no request waits', () => {
    expect(sendWaitLine(null, 'mobile-chat-1')).toBeNull()
  })

  it('reads Sending until the request is waited out, then says the Mac has not answered', () => {
    expect(sendWaitLine('mobile-chat-1', null)).toBe('Sending…')
    expect(sendWaitLine('mobile-chat-1', 'mobile-chat-1')).toBe('Your Mac has not answered yet.')
  })

  it('starts a new request at Sending even when an earlier one was waited out', () => {
    expect(sendWaitLine('mobile-chat-2', 'mobile-chat-1')).toBe('Sending…')
  })
})

describe('settleSendLock', () => {
  const before = { requestId: 'ask-1' }
  const after = { requestId: 'ask-1' }

  it('keeps a sent card locked while the connection holds', () => {
    expect(settleSendLock(SENT_SEND_LOCK, true, before)).toBe(SENT_SEND_LOCK)
    expect(settleSendLock(OPEN_SEND_LOCK, false, before)).toBe(OPEN_SEND_LOCK)
  })

  it('unlocks after a drop only on a reading of the question from after the reconnect', () => {
    const dropped = settleSendLock(SENT_SEND_LOCK, false, before)
    expect(dropped).toEqual({ kind: 'dropped', ask: before })
    expect(settleSendLock(dropped, false, before)).toBe(dropped)
    // Live again, but the question is still the one read before the drop.
    expect(settleSendLock(dropped, true, before)).toBe(dropped)
    expect(settleSendLock(dropped, true, after)).toBe(OPEN_SEND_LOCK)
  })

  it('takes a reading made while still offline as from before the drop', () => {
    const dropped = settleSendLock(settleSendLock(SENT_SEND_LOCK, false, before), false, after)
    expect(settleSendLock(dropped, true, after)).toBe(dropped)
  })
})
