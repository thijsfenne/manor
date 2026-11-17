/**
 * The server ends a Session-owned Notes row in notes.md with a hidden short id of that
 * Session, `<!-- manor-note 1a2b3c4d -->`. Rows written before 2026-11-17 carry a longer
 * form with a timestamp and a fingerprint; both are stripped for display. Dates now live
 * in the server's own store.
 */
export const NOTE_MARKER = /\s*<!-- manor-note [^>\n]*? -->$/

const DAY_MS = 86_400_000
/** An open row unchanged this long gets an age next to it. */
export const NOTE_AGE_AFTER_MS = 3 * DAY_MS

/** `open 4d` for an open row unchanged for three days or more, else undefined. */
export const noteAge = (updatedAt: number, now: number): string | undefined =>
  now - updatedAt >= NOTE_AGE_AFTER_MS ? `open ${Math.floor((now - updatedAt) / DAY_MS)}d` : undefined
