import { describe, expect, it } from 'vitest'

import { clampPan, fittedSize, panLimit, zoomAround } from './zoom'

describe('zoom geometry', () => {
  it('fits a wide picture to the width and a tall one to the height', () => {
    expect(fittedSize(400, 800, 2)).toEqual({ width: 400, height: 200 })
    expect(fittedSize(800, 400, 0.5)).toEqual({ width: 200, height: 400 })
    expect(fittedSize(400, 800, null)).toEqual({ width: 400, height: 800 })
  })

  it('lets a zoomed picture move only until its edge meets the frame', () => {
    // A 400x200 picture in a 400x800 frame at 2x is 800x400: 200 of slack sideways, none up or down.
    expect(panLimit(400, 400, 2)).toBe(200)
    expect(panLimit(800, 200, 2)).toBe(0)
    expect(clampPan(500, 400, 400, 2)).toBe(200)
    expect(clampPan(-500, 400, 400, 2)).toBe(-200)
    expect(clampPan(120, 800, 200, 2)).toBe(0)
  })

  it('keeps the point under the fingers in place while zooming', () => {
    // Zooming 1x to 2x around a point 100 right of centre moves the picture 100 left.
    expect(zoomAround(100, 100, 0, 1, 2)).toBe(-100)
    // That point stays put on a further zoom from there.
    const offset = zoomAround(100, 100, -100, 2, 4)
    expect(offset + (100 - -100) / 2 * 4).toBe(100)
  })
})
