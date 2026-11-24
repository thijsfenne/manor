/**
 * Past this a sent message stops being something the user typed and starts being something
 * they pasted. The same word count as the Mac's bubble; the cut itself is in lines.
 */
export const CLAMP_WORDS = 150

/** Whether a sent message is long enough to fold behind "Show more". */
export function isLongMessage(text: string): boolean {
  const trimmed = text.trim()
  return trimmed !== '' && trimmed.split(/\s+/).length > CLAMP_WORDS
}
