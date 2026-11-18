import { describe, expect, it } from 'vitest'

import { shortModelName } from './modelPillLabel'

describe('shortModelName', () => {
  it('moves the name before the version for GPT models', () => {
    expect(shortModelName('GPT-6.2 Sol')).toBe('Sol 6.2')
    expect(shortModelName('GPT-6 Luna')).toBe('Luna 6')
    expect(shortModelName('GPT-6.1 Terra')).toBe('Terra 6.1')
  })

  it('keeps every other model name as it is', () => {
    expect(shortModelName('Opus 5.5')).toBe('Opus 5.5')
    expect(shortModelName('Auto')).toBe('Auto')
    expect(shortModelName('GPT-5.2')).toBe('GPT-5.2')
  })
})
