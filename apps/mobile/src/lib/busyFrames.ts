/** How far a key at the same moment as the one before it moves, as a fraction of the loop. */
const JUMP = 1e-6

/**
 * Keyframe selectors for a timed track, as Reanimated reads them: fractions of the
 * loop, as strings. A zero-length beat puts two keys at one moment (a jump), and a
 * keyframes object would fold those into one, so the later key moves a hair past the
 * earlier and the jump survives.
 */
export function keyOffsets(times: readonly number[], total: number): string[] {
  let last = -1
  return times.map((t) => {
    const offset = Math.max(Math.min(t / total, 1), last + JUMP)
    last = offset
    return String(offset)
  })
}
