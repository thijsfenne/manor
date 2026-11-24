import { describe, expect, it } from 'vitest'

import { CLAMP_WORDS, isLongMessage } from './longMessage'

const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')

describe('isLongMessage', () => {
  it('folds only past the threshold, counting words across lines and blanks', () => {
    expect(isLongMessage(words(CLAMP_WORDS))).toBe(false)
    expect(isLongMessage(words(CLAMP_WORDS + 1))).toBe(true)
    expect(isLongMessage(`${words(CLAMP_WORDS)}\n\n  extra`)).toBe(true)
    expect(isLongMessage('   ')).toBe(false)
  })
})
