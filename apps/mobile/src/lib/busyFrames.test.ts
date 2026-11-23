import { dotsPlan } from '@manor/client-runtime/busy-face'
import { describe, expect, it } from 'vitest'

import { keyOffsets } from './busyFrames'

describe('keyOffsets', () => {
  it('keeps two keys at one moment apart, which a keyframes object keyed by offset needs', () => {
    const offsets = keyOffsets([0, 1, 1, 2], 2).map(Number)
    expect(new Set(offsets).size).toBe(4)
    expect(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]!)).toBe(true)
    expect([offsets[0], offsets.at(-1)]).toEqual([0, 1])
  })

  it('keeps every key of the dots melt in order inside the loop', () => {
    const plan = dotsPlan([[5, 8], [-4, 8]])
    for (const track of [...plan.eyes, plan.body, ...plan.dots]) {
      const times = track.map((key) => key.t)
      const offsets = keyOffsets(times, plan.seconds).map(Number)
      expect(new Set(offsets).size).toBe(times.length)
      expect(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]!)).toBe(true)
      expect(offsets[0]).toBe(0)
      expect(offsets.at(-1)).toBe(1)
    }
  })
})
