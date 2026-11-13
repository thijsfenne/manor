import { _layout } from '@manor/blobatar'
import { describe, expect, it } from 'vitest'
import { BLOB_FACE_TRAITS, BLOB_SHAPES, blobShapeOf, blobShapeTraits } from './blobShapes'

/** What the library actually built at this trait position. */
const shapeAt = (trait: number) => _layout('any name', { traits: { shape: trait } }).shape

/** The position this table hands back to pin a silhouette. */
const traitOf = (id: string) => blobShapeTraits(id)?.shape ?? -1

describe('blobatar shapes', () => {
  it('pins the shared body and eye proportions', () => {
    expect(BLOB_FACE_TRAITS).toEqual({
      'body.r': 0.999,
      'body.ratio': 0.999,
      'body.n': 0.632,
      'eye.rx': 0.999,
      'eye.ratio': 0.222,
      'eye.scale': 0.4782608695652174,
      'eye.stretch': 0.45454545454545453,
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

  it('names every silhouette the library can build, and no more', () => {
    const built = new Set(Array.from({ length: 1001 }, (_, step) => shapeAt(step / 1000)))

    expect(new Set(BLOB_SHAPES.map((shape) => shape.id))).toEqual(built)
  })

  // The bands are the whole contract with the library: a retuned one moves a persona
  // to a neighbouring silhouette without anything failing to compile.
  it('starts every band where the library starts it', () => {
    for (const [index, shape] of BLOB_SHAPES.entries()) {
      expect(shapeAt(shape.from)).toBe(shape.id)
      if (index > 0) expect(shapeAt(shape.from - 0.001)).not.toBe(shape.id)
    }
  })

  it('pins a chosen silhouette clear of its band edges', () => {
    for (const shape of BLOB_SHAPES) {
      expect(shapeAt(traitOf(shape.id))).toBe(shape.id)
      expect(shapeAt(traitOf(shape.id) - 0.004)).toBe(shape.id)
      expect(shapeAt(traitOf(shape.id) + 0.004)).toBe(shape.id)
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

  it('overrides nothing for a persona who has chosen nothing', () => {
    expect(blobShapeTraits(undefined)).toBeUndefined()
    expect(blobShapeTraits('rhombus')).toBeUndefined()
  })
})
