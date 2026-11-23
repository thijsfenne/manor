import { _layout, blobatar } from '@manor/blobatar'
import { inside } from '@manor/client-runtime/busy-face'
import { outlinePoints } from '@manor/client-runtime/face-gesture'
import { describe, expect, it } from 'vitest'
import { BLOB_FACE_TRAITS, BLOB_SHAPES, blobShapeOf } from './blobShapes'

/** What the library actually built at this trait position. */
const shapeAt = (trait: number) => _layout('any name', { traits: { shape: trait } }).shape

const banded = BLOB_SHAPES.filter((shape) => shape.from !== undefined)

describe('blobatar shapes', () => {
  it('pins the shared body and eye proportions', () => {
    expect(BLOB_FACE_TRAITS).toEqual({
      'body.r': 0.999,
      'body.ratio': 0.999,
      'body.n': 0.632,
      'eye.rx': 0.999,
      'eye.ratio': 0.65,
      'eye.scale': 0.5,
      'eye.stretch': 0.5,
      'eye.n': 0,
      'eye.gap': 0,
      'eye.lean': 0.487,
      'gaze.x': 0.999,
      'gaze.y': 0,
    })
  })

  it('keeps the resting eyes the same size', () => {
    for (const name of ['Jeeves', 'Smith', 'Wren']) {
      const [left, right] = _layout(name, { traits: BLOB_FACE_TRAITS }).eyes

      expect(right?.rx).toBeCloseTo(left?.rx ?? 0)
      expect(right?.ry).toBeCloseTo(left?.ry ?? 0)
    }
  })

  it('names every silhouette a name can come out as, and no more', () => {
    const built = new Set(Array.from({ length: 1001 }, (_, step) => shapeAt(step / 1000)))

    expect(new Set(banded.map((shape) => shape.id))).toEqual(built)
  })

  it('draws every silhouette by name, the chosen-only ones included', () => {
    for (const shape of BLOB_SHAPES) expect(_layout('any name', { shape: shape.id }).shape).toBe(shape.id)
    // A name this build does not know draws the seeded shape.
    expect(_layout('Smith', { shape: 'rhombus' }).shape).toBe(_layout('Smith', {}).shape)
  })

  // The bands are the whole contract with the library: a retuned one moves a persona
  // to a neighbouring silhouette without anything failing to compile.
  it('starts every band where the library starts it', () => {
    for (const [index, shape] of banded.entries()) {
      const from = shape.from ?? 0
      expect(shapeAt(from)).toBe(shape.id)
      if (index > 0) expect(shapeAt(from - 0.001)).not.toBe(shape.id)
    }
  })

  // Read off the library's own hash rather than by rendering, so this is the pair
  // that has to be held together.
  it('reads the same silhouette off a name as the library draws', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const name = `Agent ${seed}`
      expect(blobShapeOf(name)?.id).toBe(_layout(name, {}).shape)
    }
  })

  // A working face clips its moving eyes to the core path alone, so eyes outside it
  // would be cut off mid-loop while the head around them still shows.
  it('keeps the eyes inside the core path of every silhouette', () => {
    for (const shape of BLOB_SHAPES) {
      for (const name of ['Jeeves', 'Smith', 'Wren']) {
        const markup = blobatar(name, { traits: BLOB_FACE_TRAITS, shape: shape.id })
        const [head = '', eyes = ''] = [...markup.matchAll(/<g fill="[^"]+">(.*?)<\/g>/g)].map((group) => group[1] ?? '')
        const paths = (group: string) => [...group.matchAll(/<path d="([^"]+)"/g)].map((path) => path[1] ?? '')
        const outline = outlinePoints(paths(head).slice(-1), [])
        const eyePoints = outlinePoints(paths(eyes), [])
        expect(eyePoints.length).toBeGreaterThan(0)
        for (const point of eyePoints) expect(inside(outline, point), `${shape.id} on ${name}`).toBe(true)
      }
    }
  })

  it('lets a chosen silhouette win over the seeded one', () => {
    expect(blobShapeOf('Smith', 'triangle')?.id).toBe('triangle')
    expect(blobShapeOf('Smith')?.id).toBe(_layout('Smith', {}).shape)
    // A shape saved by a build that knew more shapes than this one.
    expect(blobShapeOf('Smith', 'rhombus')?.id).toBe(_layout('Smith', {}).shape)
  })

  it('lifts the one silhouette that draws high, and nothing else', () => {
    expect(BLOB_SHAPES.filter((shape) => shape.lift !== undefined).map((shape) => shape.id)).toEqual([
      'triangle',
    ])
  })
})
