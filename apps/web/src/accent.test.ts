import { palette } from '@manor/blobatar'
import { describe, expect, it } from 'vitest'
import { accentHue } from './accent'
import { PERSONA_COLOR_OPTIONS } from './persona'

/** Degrees between two hues the short way round, so 359° and 1° are 2° apart. */
const apart = (one: number, other: number) => {
  const gap = Math.abs(one - other) % 360
  return Math.min(gap, 360 - gap)
}

describe('accent hue', () => {
  // The contract is not "some hue" but "the hue blobatar would have used", so it
  // is checked against the library's own ramp rather than against numbers typed
  // here. A library that moves to another colour space fails this, which is the
  // point: our conversion is the half of the pair that would silently drift.
  it('lands on the hue blobatar built the colour from', () => {
    for (const hue of [0, 45, 90, 135, 180, 225, 265, 300, 350]) {
      const head = palette(hue, true, 0.7).head
      if (head === undefined) throw new Error('The blobatar ramp stopped returning a head colour')
      expect(apart(accentHue(head) ?? -1, hue)).toBeLessThan(1)
    }
  })

  it('reads the same hue from a shorthand hex as from its long form', () => {
    expect(accentHue('#7af')).toBeCloseTo(accentHue('#77aaff') ?? -1, 5)
  })

  it('gives every persona colour a hue of its own', () => {
    const hues = PERSONA_COLOR_OPTIONS.map((option) => accentHue(option.value))

    expect(hues.every((hue) => hue !== undefined)).toBe(true)
    // Distinct, but not evenly spread: Orange and Amber sit ~10° apart, which is
    // two blobatars of the same colour if both are worn in one house. That is the
    // palette's own doing rather than the conversion's, and it was already true
    // of the swatches themselves.
    expect(new Set(hues).size).toBe(PERSONA_COLOR_OPTIONS.length)
    for (const [index, hue] of hues.entries()) {
      for (const other of hues.slice(index + 1)) {
        expect(apart(hue ?? 0, other ?? 0)).toBeGreaterThan(9)
      }
    }
  })

  it('has no hue for a colour that is not a hex', () => {
    // What a couple of avatar call sites actually pass: a token, not a colour.
    expect(accentHue('var(--color-dim)')).toBeUndefined()
    expect(accentHue('')).toBeUndefined()
    expect(accentHue('#12345')).toBeUndefined()
  })
})
