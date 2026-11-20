import { describe, expect, it } from 'vitest'

import { rubberBand } from './rubberBand'

describe('rubberBand', () => {
  it('follows the value inside the range', () => {
    expect(rubberBand(30, 0, 52, 0.2)).toBe(30)
    expect(rubberBand(52, 0, 52, 0.2)).toBe(52)
  })

  it('moves only a share of the distance past either edge', () => {
    expect(rubberBand(102, 0, 52, 0.2)).toBe(62)
    expect(rubberBand(-50, 0, 52, 0.2)).toBe(-10)
  })
})
