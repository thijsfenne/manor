import type { MyMindArtifact } from '@manor/contracts'

/** The width one column wants before the grid hands out another one. */
const TARGET_COLUMN = 268
const MIN_COLUMNS = 2
const MAX_COLUMNS = 6
const FALLBACK_COLUMNS = 4

/**
 * The width every height is estimated against, whatever the grid actually measures.
 *
 * Deliberately a constant and not the real column width. Estimated height feeds the
 * choice of column, so letting the real width in would mean a sidebar folding away
 * reshuffles the whole wall, which is the same defect as the CSS `columns` this
 * replaced. Pinned, only the *number* of columns can move a card, and that is a change
 * of shape you asked for. The cost is a slightly less even fill at other widths, which
 * nobody can see; cards moving under your cursor, everybody can.
 */
const NOMINAL_COLUMN = 268

/** Portrait-ish, which is what an unmeasured screenshot or article hero usually is. */
const FALLBACK_RATIO = 0.72
/** The cap the card itself puts on a picture, so a tall one stops counting past it. */
const MAX_IMAGE = 520
const TITLE_LINE = 20
const EXCERPT_LINE = 18.6
const EXCERPT_LINES = 6
const META_ROW = 24
const CARD_PADDING = 24
/** A card with no picture opens with room where the picture would have been. */
const IMAGELESS_TOP = 48
const GAP = 12

export function columnsFor(width: number): number {
  if (width <= 0) return FALLBACK_COLUMNS
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(width / TARGET_COLUMN)))
}

/**
 * Roughly how tall a card draws at the nominal column width, in pixels. Rough is the
 * whole point: it only has to rank columns against each other, and a card whose
 * picture lands twenty pixels off changes nothing about which column was shortest.
 */
export function estimateCardHeight(artifact: MyMindArtifact): number {
  const ratio =
    artifact.imageWidth !== undefined && artifact.imageHeight !== undefined && artifact.imageWidth > 0
      ? artifact.imageHeight / artifact.imageWidth
      : FALLBACK_RATIO
  const hasImage = artifact.imageUrl !== undefined
  const image = hasImage ? Math.min(MAX_IMAGE, NOMINAL_COLUMN * ratio) : 0
  const perLine = Math.round(NOMINAL_COLUMN / 7.6)
  const titleLines = Math.min(3, Math.max(1, Math.ceil(artifact.title.length / perLine)))
  // Only a card with nothing to look at keeps its text, so only that one pays for it.
  const excerpt =
    hasImage || (artifact.note ?? artifact.summary ?? artifact.content) === undefined
      ? 0
      : 6 + EXCERPT_LINES * EXCERPT_LINE
  return (
    image +
    (hasImage ? CARD_PADDING / 2 : IMAGELESS_TOP) +
    titleLines * TITLE_LINE +
    excerpt +
    META_ROW +
    CARD_PADDING / 2 +
    GAP
  )
}

/**
 * The grid's columns, filled by hand rather than by CSS `columns`.
 *
 * The browser's own multi-column layout rebalances the whole set every time the page
 * grows, so an infinite scroll moves the card somebody is reading into another column.
 * Assigning each artifact to whichever column is shortest *at the moment it arrives*
 * keeps every earlier placement untouched: appending only ever writes to the end of one
 * column, so what is on screen never moves. It also stays balanced, which round-robin
 * would not be on a wall of pictures with wildly different heights.
 *
 * Only `columns` may change an assignment. Nothing else is an input, by design, see
 * `NOMINAL_COLUMN`.
 */
export function artifactColumns(artifacts: readonly MyMindArtifact[], columns: number): MyMindArtifact[][] {
  const count = Math.max(1, Math.floor(columns))
  const buckets: MyMindArtifact[][] = Array.from({ length: count }, () => [])
  const filled = Array.from({ length: count }, () => 0)
  for (const artifact of artifacts) {
    let shortest = 0
    let shortestHeight = filled[0] ?? 0
    for (let index = 1; index < count; index += 1) {
      const height = filled[index] ?? 0
      // A tolerance, so equal columns fill left to right instead of on float noise.
      if (height < shortestHeight - 0.5) {
        shortest = index
        shortestHeight = height
      }
    }
    buckets[shortest]?.push(artifact)
    filled[shortest] = shortestHeight + estimateCardHeight(artifact)
  }
  return buckets
}
