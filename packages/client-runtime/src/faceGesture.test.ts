import { blobatar } from '@manor/blobatar'
import { describe, expect, it } from 'vitest'
import { BLOB_FACE_TRAITS, BLOB_SHAPES } from './blobShapes'
import { GESTURES, fit, frameOf, margin, outlinePoints, plan, type Gesture, type GestureId } from './faceGesture'

/** The head's parts out of the library's own markup, the way a client finds them. */
function frame(name: string, shape: string) {
  const markup = blobatar(name, { traits: BLOB_FACE_TRAITS, shape })
  const head = markup.slice(markup.indexOf('<g fill='), markup.lastIndexOf('<g fill='))
  const paths = [...head.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]!)
  const circles = [...head.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.-]+)"/g)].map((match) => ({ cx: Number(match[1]), cy: Number(match[2]), r: Number(match[3]) }))
  return frameOf(outlinePoints(paths, circles))
}

const ids = Object.keys(GESTURES) as GestureId[]
const names = Array.from({ length: 24 }, (_, index) => `persona ${index}`)

describe('a body gesture', () => {
  it('keeps every silhouette inside its slot, at or near full size', () => {
    for (const { id: shape } of BLOB_SHAPES) {
      for (const name of names) {
        const face = frame(name, shape)
        expect(face.pts.length).toBeGreaterThan(8)
        for (const id of ids) {
          const gesture: Gesture = GESTURES[id]
          const fitted = fit(face, gesture)
          expect(margin(face, gesture, fitted), `${id} on ${shape}`).toBeGreaterThanOrEqual(1)
          // Room is found by drawing in first. Only a jump on the largest bodies plays smaller.
          expect(fitted.amount, `${id} on ${shape}`).toBeGreaterThanOrEqual(id === 'bounce' ? 0.6 : 1)
          expect(fitted.drawIn).toBeGreaterThanOrEqual(0.8)
        }
      }
    }
  })

  it('would clip a tight body that did not draw in', () => {
    const tight = BLOB_SHAPES.flatMap(({ id: shape }) => names.map((name) => frame(name, shape))).filter((face) => fit(face, GESTURES.bounce).drawIn < 1)
    expect(tight.length).toBeGreaterThan(0)
    for (const face of tight) expect(margin(face, GESTURES.bounce, { amount: 1, drawIn: 1, tuck: 1 })).toBeLessThan(1)
  })

  it('starts and ends each loop on the same key, so it repeats without a jump', () => {
    for (const id of ids) {
      const gesture: Gesture = GESTURES[id]
      if (gesture.fig) expect(gesture.fig.at(-1)![1], id).toEqual(gesture.fig[0]![1])
      // A full turn reads the same as none.
      if (gesture.rot) expect((gesture.rot.at(-1)![1] - gesture.rot[0]![1]) % 360, id).toBe(0)
    }
  })

  it('hands a client keys it can play as they are', () => {
    const face = frame('Wren', 'triangle')
    const roll = plan('roll', face)
    expect(roll.rot.map((key) => key.degrees)).toEqual([0, 360, 360])
    // A triangle has to draw in to turn all the way round, and only while it turns.
    expect(roll.fit.tuck).toBeLessThan(1)
    expect(roll.draw[1]?.d).toBeCloseTo(roll.fit.tuck * roll.fit.drawIn)
    expect(roll.draw[0]?.d).toBe(roll.fit.drawIn)
    // A gesture that only turns still hands over a resting figure, so a client plays every track.
    expect(plan('tilt', face).fig.every((key) => key.x === 0 && key.sx === 1)).toBe(true)
  })
})
