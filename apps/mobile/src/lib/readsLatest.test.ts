import { describe, expect, it } from 'vitest'

import { readsLatest } from './readsLatest'

describe('readsLatest', () => {
  it('reads the latest at the end and away from it higher up', () => {
    expect(readsLatest({ offset: 1080, viewport: 800, content: 1500, insetEnd: 400 })).toBe(true)
    expect(readsLatest({ offset: 600, viewport: 800, content: 1500, insetEnd: 400 })).toBe(false)
  })

  it('reads the latest once the content shrinks until the whole thread fits, at the same offset', () => {
    expect(readsLatest({ offset: 0, viewport: 800, content: 2400, insetEnd: 200 })).toBe(false)
    expect(readsLatest({ offset: 0, viewport: 800, content: 560, insetEnd: 200 })).toBe(true)
  })
})
