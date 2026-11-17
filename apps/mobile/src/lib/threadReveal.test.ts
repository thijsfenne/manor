import { describe, expect, it } from 'vitest'

import { leaveEventReveal, takeEventReveal } from './threadReveal'

describe('event reveal', () => {
  it('hands the picked message to its own chat, once', () => {
    leaveEventReveal('chat-a', 'evt_7')
    expect(takeEventReveal('chat-b')).toBeNull()
    expect(takeEventReveal('chat-a')).toBe('evt_7')
    expect(takeEventReveal('chat-a')).toBeNull()
  })

  it('keeps only the latest pick', () => {
    leaveEventReveal('chat-a', 'evt_1')
    leaveEventReveal('chat-b', 'evt_2')
    expect(takeEventReveal('chat-a')).toBeNull()
    expect(takeEventReveal('chat-b')).toBe('evt_2')
  })
})
