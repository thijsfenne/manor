export const EFFECT_REVIEW_INPUT_LIMIT = 16_000

/** Omit the entire input rather than approve a call whose sensitive parts were hidden. */
export function effectReviewArguments(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  try {
    const encoded = JSON.stringify(value)
    if (encoded.length > EFFECT_REVIEW_INPUT_LIMIT) return undefined
    // Connector credentials normally live in the capability env, never arguments.
    // Reject explicit credentials here too; this is not a general secret detector.
    if (/"[^"\\]*(?:password|secret|token|authorization|api[_-]?key|cookie|headers)[^"\\]*"\s*:/i.test(encoded)) return undefined
    return JSON.parse(encoded) as unknown
  } catch {
    return undefined
  }
}
