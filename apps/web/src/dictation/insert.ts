/**
 * Where a finished dictation lands in the draft: at the caret, or appended when there
 * is none, spaced so it reads as part of the sentence around it. The caret that comes
 * back stands right after the inserted words, which is where the composer puts focus.
 */
export function insertDictation(value: string, caret: number | null, text: string): { text: string; caret: number } {
  const words = text.trim()
  const at = caret === null ? value.length : Math.min(Math.max(caret, 0), value.length)
  if (words === '') return { text: value, caret: at }
  const before = value.slice(0, at)
  const after = value.slice(at)
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : ''
  const trail = /^[\p{L}\p{N}_]/u.test(after) ? ' ' : ''
  const inserted = `${lead}${words}${trail}`
  return { text: `${before}${inserted}${after}`, caret: before.length + lead.length + words.length }
}
