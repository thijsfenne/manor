import { describe, expect, it } from 'vitest'
import { peekAfterMove } from '../src/useSidebar'

const at = (x: number, over: Partial<{ peeking: boolean; held: boolean }> = {}) =>
  peekAfterMove({ x, width: 288, peeking: true, held: false, ...over })

describe('sidebar peek', () => {
  it('starts only at the very left edge', () => {
    expect(at(0, { peeking: false })).toBe(true)
    expect(at(8, { peeking: false })).toBe(true)
    expect(at(9, { peeking: false })).toBe(false)
    expect(at(300, { peeking: false })).toBe(false)
  })

  it('survives anywhere over the open panel and ends past its handle', () => {
    expect(at(287)).toBe(true)
    expect(at(295)).toBe(true)
    expect(at(296)).toBe(false)
  })

  it('holds the panel open for an overlay anchored to it, wherever the pointer went', () => {
    // The project card sits at width + 8 and runs on from there, which is exactly
    // the ground that would otherwise fold the sidebar away under it.
    expect(at(296, { held: true })).toBe(true)
    expect(at(900, { held: true })).toBe(true)
  })
})
