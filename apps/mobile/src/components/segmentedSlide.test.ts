import { describe, expect, it } from 'vitest'

import { pressedValue, slideDuration } from './segmentedSlide'

describe('slideDuration', () => {
  it('takes longer for a longer jump, up to a cap', () => {
    expect(slideDuration(0, 1)).toBe(150)
    expect(slideDuration(2, 0)).toBe(300)
    expect(slideDuration(0, 9)).toBe(360)
  })
})

describe('pressedValue', () => {
  it('selects another segment', () => {
    expect(pressedValue({ value: 'media' }, 'all', false)).toBe('media')
  })

  it('ignores the selected segment, a disabled segment and a disabled control', () => {
    expect(pressedValue({ value: 'all' }, 'all', false)).toBeUndefined()
    expect(pressedValue({ value: 'media', disabled: true }, 'all', false)).toBeUndefined()
    expect(pressedValue({ value: 'media' }, 'all', true)).toBeUndefined()
  })
})
