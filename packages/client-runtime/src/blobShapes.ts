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

/** The sidebar face holds its gaze toward the upper right. */
export const SIDEBAR_WORKING_GAZE = { 'gaze.x': 0.999, 'gaze.y': 0 } as const

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
  'eye.ratio': 0.222,
  'eye.scale': 0.4782608695652174,
  'eye.stretch': 0.45454545454545453,
  'eye.n': 0,
  'eye.gap': 0,
  'eye.lean': 0.487,
  'gaze.x': 0.999,
  'gaze.y': 0,
} as const

/**
 * The ten silhouettes a blobatar can be built on.
 *
 * The library picks one from a `shape` trait: a position in [0, 1) read through a
 * table of bands, not an index, and the bands are not equal widths — `round` covers
 * the first fifth and `triangle` the last fiftieth. `from` is where each band
 * starts, probed off the library rather than typed from its source, which is what
 * lets this file answer both questions the UI has: which silhouette a name comes
 * out as, and which position to hand back to pin one. `blobShapes.test` re-probes
 * the whole table and fails if a band moves.
 *
 * Their names are the library's, kept as they are: what a persona wears should be
 * findable in the library's own docs when someone goes looking.
 */
export interface BlobShape {
  id: string
  label: string
  /** Where this silhouette's band starts in the `shape` trait. */
  from: number
  /**
   * How far down the face has to move to sit level with a name beside it, in
   * viewBox units.
   *
   * Nine of the ten silhouettes draw their ink centred in the viewBox and need
   * nothing. `triangle` does not: its ink sits from y≈14 to y≈72, seven units high
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
]

/** The middle of a silhouette's band, which is the position that pins it. */
const middleOf = (index: number) => {
  const start = BLOB_SHAPES[index]?.from ?? 0
  return (start + (BLOB_SHAPES[index + 1]?.from ?? 1)) / 2
}

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
  return [...BLOB_SHAPES].reverse().find((option) => position >= option.from)
}

/**
 * The trait override for a chosen silhouette, or nothing at all for a persona who
 * has not chosen one: an absent override is what leaves the name picking her shape,
 * which is the whole of the fallback.
 */
export function blobShapeTraits(shape: string | undefined) {
  const index = BLOB_SHAPES.findIndex((option) => option.id === shape)
  return index === -1 ? undefined : { shape: middleOf(index) }
}
