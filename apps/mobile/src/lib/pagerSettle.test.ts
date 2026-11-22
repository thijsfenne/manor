import { describe, expect, it } from 'vitest'

import { pagerSettle } from './pagerSettle'

describe('pagerSettle', () => {
  it('lands where it was heading when the system cancels the swipe', () => {
    expect(pagerSettle(0.9, -2000, true, 0)).toBe(0)
    expect(pagerSettle(0.1, 2000, true, 1)).toBe(1)
  })

  it('follows a fling whatever the distance', () => {
    expect(pagerSettle(0.1, -800, false, 0)).toBe(1)
    expect(pagerSettle(0.9, 800, false, 1)).toBe(0)
  })

  it('lands on the nearer page after a slow release', () => {
    expect(pagerSettle(0.6, -100, false, 0)).toBe(1)
    expect(pagerSettle(0.4, -100, false, 0)).toBe(0)
  })
})
