import { towardStops } from '@manor/client-runtime/face-activity'
import { frameOf, plan } from '@manor/client-runtime/face-gesture'
import { describe, expect, it } from 'vitest'
import { eyeFrames, gestureFrames, type Transform } from './faceFrames'

// A round body that fills its slot, and a small one with room to spare.
const ring = (r: number) => frameOf(Array.from({ length: 48 }, (_, i) => [50 + r * Math.cos((i * Math.PI) / 24), 50 + r * Math.sin((i * Math.PI) / 24)] as const))
const value = (transform: Transform, key: string) => transform.find((step) => key in step)![key]

describe('a gesture as native keyframes', () => {
  it('rests at the first key of a held gesture and loops from there, so nothing jumps', () => {
    const { fig, turn } = gestureFrames(plan('sink', ring(30)), 0.32)
    expect(value(fig.rest, 'scaleX')).toBe(1)
    // Measured from the rest: nothing at the ends, the breath out in between.
    expect(value(fig.loop.keyframes['0%']!.transform, 'scaleY')).toBe(1)
    expect(value(fig.loop.keyframes['50%']!.transform, 'scaleY')).toBeCloseTo(0.93)
    expect(value(fig.loop.keyframes['100%']!.transform, 'scaleY')).toBe(1)
    expect(fig.loop.passes).toBe('infinite')
    expect(value(turn.rest, 'rotate')).toBe('0deg')
  })

  it('plays a counted gesture end to end, starting and ending at home', () => {
    const moves = plan('bounce', ring(40))
    const { fig, turn } = gestureFrames(moves, 0.32, 2)
    expect(fig.loop.duration).toBe(moves.ms * 2)
    expect(fig.loop.passes).toBe(1)
    expect(value(fig.rest, 'translateY')).toBe(0)
    // The jump of the first pass and the jump of the second; the small hop after each stays under a point here.
    const jumps = Object.values(fig.loop.keyframes).filter((key) => Number(value(key.transform, 'translateY')) < -1)
    expect(jumps).toHaveLength(2)
    // A body with no room draws in for the run and lets go at its end.
    expect(moves.fit.drawIn).toBeLessThan(1)
    expect(value(turn.loop.keyframes['0%']!.transform, 'scale')).toBe(1)
    expect(value(turn.loop.keyframes['100%']!.transform, 'scale')).toBe(1)
    expect(Object.values(turn.loop.keyframes).some((key) => value(key.transform, 'scale') === moves.fit.drawIn)).toBe(true)
  })

  it('keeps every keyframe the same shape, which the native runtime needs', () => {
    for (const id of ['nod', 'shake', 'sink', 'bounce'] as const) {
      const { fig, turn } = gestureFrames(plan(id, ring(36)), 0.32, id === 'sink' ? undefined : 1)
      for (const layer of [fig, turn]) {
        const shape = layer.rest.map((step) => Object.keys(step)[0])
        for (const key of Object.values(layer.loop.keyframes)) expect(key.transform.map((step) => Object.keys(step)[0])).toEqual(shape)
      }
    }
  })
})

describe('an added eye move as native keyframes', () => {
  it('rests at home and measures the look toward the reader from there', () => {
    const stops = towardStops(3)
    const layer = eyeFrames(stops, 0.5, 1000)
    expect(layer.rest).toEqual([{ translateX: stops[0]!.x * 0.5 }, { translateY: stops[0]!.y * 0.5 }])
    expect(layer.loop.keyframes['0%']!.transform).toEqual([{ translateX: 0 }, { translateY: 0 }])
    const last = stops.at(-1)!
    expect(layer.loop.keyframes['100%']!.transform).toEqual([{ translateX: (last.x - stops[0]!.x) * 0.5 }, { translateY: (last.y - stops[0]!.y) * 0.5 }])
  })
})
