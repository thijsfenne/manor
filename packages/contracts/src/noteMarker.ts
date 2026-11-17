/**
 * The server keeps a hidden source marker at the end of each Notes row in notes.md.
 * Readers strip it for display and use its date for the age of an open row.
 */
export const NOTE_MARKER = /\s*<!-- manor-note handoff=([^\s]+) updated=(\d+) text=([a-f0-9]+) -->$/

const DAY_MS = 86_400_000
/** An open row unchanged this long gets an age next to it. */
export const NOTE_AGE_AFTER_MS = 3 * DAY_MS

/** `open 4d` for an open row unchanged for three days or more, else undefined. */
export const noteAge = (updatedAt: number, now: number): string | undefined =>
  now - updatedAt >= NOTE_AGE_AFTER_MS ? `open ${Math.floor((now - updatedAt) / DAY_MS)}d` : undefined
