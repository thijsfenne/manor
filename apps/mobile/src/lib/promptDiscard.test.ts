import { describe, expect, it, vi } from 'vitest'

import { leavePrompt } from './promptDiscard'

describe('leavePrompt', () => {
  it('closes an untouched draft without asking', () => {
    const close = vi.fn()
    const ask = vi.fn()
    leavePrompt({ draft: 'Ship it', opened: 'Ship it', close, ask })
    expect(close).toHaveBeenCalledOnce()
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks before dropping a changed draft and closes only on Discard', () => {
    const close = vi.fn()
    const ask = vi.fn()
    leavePrompt({ draft: 'Ship it now', opened: 'Ship it', close, ask })
    expect(close).not.toHaveBeenCalled()
    ask.mock.calls[0]?.[0]()
    expect(close).toHaveBeenCalledOnce()
  })
})
