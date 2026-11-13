import { BUSY_LOOK, order, timeline } from '@manor/client-runtime/busy-face'
import { describe, expect, it } from 'vitest'

import { keyOffsets } from './busyFrames'

describe('keyOffsets', () => {
  it('keeps every key of a full busy loop, its jumps included, in order inside the loop', () => {
    const plan = timeline(order('shuffle', 0), [9, 0], [[5, 8], [-4, 8]], BUSY_LOOK.dots)
    for (const track of [...plan.eyes, plan.body, ...plan.dots]) {
      const times = track.map((key) => key.t)
      const offsets = keyOffsets(times, plan.total).map(Number)
      // A zero-length beat is two keys at one moment; a keyframes object keyed by offset keeps both only apart.
      expect(new Set(offsets).size).toBe(times.length)
      expect(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]!)).toBe(true)
      expect(offsets[0]).toBe(0)
      expect(offsets.at(-1)).toBe(1)
    }
    expect(plan.eyes[0].some((stop, index) => index > 0 && stop.t === plan.eyes[0][index - 1]!.t)).toBe(true)
  })
})
