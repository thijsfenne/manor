/** Closer to the bottom than this, in points, still counts as reading the latest. */
export const NEAR_END = 24

/** Where the transcript stands, as a scroll event reports it. */
export interface TranscriptScroll {
  offset: number
  viewport: number
  content: number
  /** The keyboard and the footer live in the bottom inset, which the offset runs into. */
  insetEnd: number
}

/**
 * Whether the end of the transcript is on screen, which hides "Jump to latest". The chat
 * asks on every scroll and again when the content changes height without one, such as a
 * turn folding its steps away until the whole thread fits.
 */
export function readsLatest({ offset, viewport, content, insetEnd }: TranscriptScroll): boolean {
  const end = content + insetEnd - viewport
  // A rubber band past the oldest message in a short chat is not scrolling away.
  return end < NEAR_END || end - offset < NEAR_END
}
