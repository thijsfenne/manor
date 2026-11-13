import { scanStops, seesawStops } from '@manor/client-runtime/face-activity'
import { frameOf, plan } from '@manor/client-runtime/face-gesture'
import { describe, expect, it } from 'vitest'
import { eyeFrames, gestureFrames, type Transform } from './faceFrames'

// A round body that fills its slot, and a small one with room to spare.
const ring = (r: number) => frameOf(Array.from({ length: 48 }, (_, i) => [50 + r * Math.cos((i * Math.PI) / 24), 50 + r * Math.sin((i * Math.PI) / 24)] as const))
const value = (transform: Transform, key: string) => transform.find((step) => key in step)![key]

describe('a gesture as native keyframes', () => {
  it('rests at the first key of a held gesture and loops from there, so nothing jumps', () => {
    const { fig, turn } = gestureFrames(plan('tilt', ring(30)), 0.32)
    expect(value(turn.rest, 'rotate')).toBe('9deg')
    // Measured from the rest: nothing at the ends, the sway in between.
    expect(value(turn.loop.keyframes['0%']!.transform, 'rotate')).toBe('0deg')
    expect(value(turn.loop.keyframes['50%']!.transform, 'rotate')).toBe('-4deg')
    expect(value(turn.loop.keyframes['100%']!.transform, 'rotate')).toBe('0deg')
    expect(turn.loop.passes).toBe('infinite')
    expect(value(fig.rest, 'scaleX')).toBe(1)
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
    for (const id of ['nod', 'shake', 'tilt', 'sink', 'follow', 'bounce'] as const) {
      const { fig, turn } = gestureFrames(plan(id, ring(36)), 0.32, id === 'tilt' || id === 'sink' || id === 'follow' ? undefined : 1)
      for (const layer of [fig, turn]) {
        const shape = layer.rest.map((step) => Object.keys(step)[0])
        for (const key of Object.values(layer.loop.keyframes)) expect(key.transform.map((step) => Object.keys(step)[0])).toEqual(shape)
      }
    }
  })
})

describe('an added eye move as native keyframes', () => {
  it('rests at the first stop of the scan and reads on from there', () => {
    const layer = eyeFrames(scanStops(3), 0.5, 3900)
    expect(layer.rest).toEqual([{ translateX: -1.25 }, { translateY: -1.2 }])
    expect(layer.loop.keyframes['0%']!.transform).toEqual([{ translateX: 0 }, { translateY: 0 }])
    expect(layer.loop.keyframes['27%']!.transform).toEqual([{ translateX: 5.5 }, { translateY: 0 }])
  })

  it('leaves the seesaw at home between its swings', () => {
    const layer = eyeFrames(seesawStops(-8.4, 1), 1, 3000)
    expect(layer.rest).toEqual([{ translateX: 0 }, { translateY: 0 }])
    expect(layer.loop.keyframes['50%']!.transform).toEqual([{ translateX: 0 }, { translateY: 8.4 }])
  })
})
