import { traits } from '@manor/blobatar'

/** Existing faces keep the deep swatch until a different tone is chosen. */
export const DEFAULT_BLOB_TONE = 0.7

/** Pale neutral is omitted: it disappears against the light theme. */
export const BLOB_TONES = [
  { label: 'Pastel', value: 0.1 },
  { label: 'Mid', value: 0.5 },
  { label: 'Deep', value: DEFAULT_BLOB_TONE },
  { label: 'Bright', value: 0.9 },
  { label: 'Ink', value: 0.97 },
] as const

/** The transcript face glances away from its resting gaze while working. */
export const WORKING_GAZE = { 'gaze.x': 0.05, 'gaze.y': 0 } as const

/**
 * The shared proportions of every generated persona face.
 *
 * Identity still comes from the name, chosen silhouette and accent colour. These
 * pins only keep the body and eyes in the same compact visual family on web and
 * native instead of letting the name randomise their proportions too.
 */
export const BLOB_FACE_TRAITS = {
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
} as const

/**
 * The silhouettes a blobatar can be built on.
 *
 * The first ten are the library's banded ones: a name with no chosen shape comes out
 * as one of them, read from its `shape` trait, a position in [0, 1) through a table
 * of bands that are not equal widths. `from` is where each band starts, probed off
 * the library rather than typed from its source, so this file can say which
 * silhouette a name comes out as. `blobShapes.test` re-probes the table and fails
 * if a band moves. The last five have no band, so no name ever comes out as one and
 * adding them moved no face; they are drawn only when chosen.
 *
 * A chosen shape reaches the library by name, through its `shape` option.
 */
export interface BlobShape {
  id: string
  label: string
  /** Where this silhouette's band starts in the `shape` trait; absent for a chosen-only one. */
  from?: number
  /**
   * How far down the face has to move to sit level with a name beside it, in
   * viewBox units.
   *
   * Most silhouettes draw their ink centred in the viewBox and need nothing.
   * `triangle` does not: its ink sits from y≈14 to y≈72, seven units high
   * of centre, so in a row it floats above the text it is labelling. Measured with
   * `getBBox()` on every group but the eyes, over eight seeds per shape; redo it
   * that way if a major of the library ever moves a body.
   */
  lift?: number
}

export const BLOB_SHAPES: readonly BlobShape[] = [
  { id: 'round', label: 'Round', from: 0 },
  { id: 'organic', label: 'Organic', from: 0.22 },
  { id: 'boxy', label: 'Boxy', from: 0.48 },
  { id: 'capsule', label: 'Capsule', from: 0.6 },
  { id: 'nub', label: 'Nub', from: 0.7 },
  { id: 'cloud', label: 'Cloud', from: 0.79 },
  { id: 'droplet', label: 'Droplet', from: 0.86 },
  { id: 'hexagon', label: 'Hexagon', from: 0.915 },
  { id: 'sun', label: 'Sun', from: 0.95 },
  { id: 'triangle', label: 'Triangle', from: 0.98, lift: 7 },
  { id: 'clover', label: 'Clover' },
  { id: 'flower', label: 'Flower' },
  { id: 'star', label: 'Star' },
  { id: 'heart', label: 'Heart' },
  { id: 'ghost', label: 'Ghost' },
]

const found = (shape: string | undefined) => BLOB_SHAPES.find((option) => option.id === shape)

/**
 * The silhouette a persona actually wears: the one she was given, or the one her
 * name comes out as. A stored id this build has never heard of falls back to the
 * seeded shape rather than throwing a face away.
 *
 * `traits` is the library's own hash reader, so the answer is the same one it will
 * draw, without rendering anything to find out. `blobShapes.test` holds the two
 * together.
 */
export function blobShapeOf(name: string, chosen?: string): BlobShape | undefined {
  const pick = found(chosen)
  if (pick !== undefined) return pick
  const position = traits(name)('shape')
  return [...BLOB_SHAPES].reverse().find((option) => option.from !== undefined && position >= option.from)
}
