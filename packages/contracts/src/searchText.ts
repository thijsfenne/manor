/**
 * Text matching for the ⌘K palette, shared so the server's note search and the
 * client's chat, reminder and highlight matching agree on what "matches" means.
 *
 * A query is a list of words. A word matches where a word in the text starts with
 * it, ignoring case and diacritics ("cafe" finds "Café", "plan" finds "planning").
 * That is the same rule the server's SQLite full-text index applies to messages
 * (prefix tokens, `remove_diacritics 2`), so a highlighted word is a matched word.
 */

/** Letters and digits make words; anything else, quotes and dashes included, separates them. */
const WORD = /[\p{L}\p{N}]+/gu
const NOT_WORD = '[^\\p{L}\\p{N}]'
/** A query longer than this many words is still a search, just on its first eight. */
export const SEARCH_WORD_LIMIT = 8

/** The text lowercased with diacritics removed, and for each folded index the original one. */
export function foldForSearch(text: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  let index = 0
  for (const char of text) {
    const plain = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    for (let at = 0; at < plain.length; at += 1) map.push(index)
    folded += plain
    index += char.length
  }
  map.push(index)
  return { folded, map }
}

/** The query's words, folded, at most `SEARCH_WORD_LIMIT`. Empty means nothing to search. */
export function searchWords(query: string): string[] {
  return (foldForSearch(query.normalize('NFKC')).folded.match(WORD) ?? []).slice(0, SEARCH_WORD_LIMIT)
}

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordStart = (word: string) => `(?<![\\p{L}\\p{N}])${escape(word)}`

/** Every place a query word starts a word in `text`, as `[start, end)` in the original text, in order. */
export function searchMatches(text: string, words: readonly string[]): Array<[number, number]> {
  if (words.length === 0) return []
  const { folded, map } = foldForSearch(text)
  const pattern = new RegExp(words.map(wordStart).sort((a, b) => b.length - a.length).join('|'), 'gu')
  const ranges: Array<[number, number]> = []
  for (const match of folded.matchAll(pattern)) {
    const start = map[match.index] ?? 0
    const end = map[match.index + match[0].length] ?? text.length
    if (end > start) ranges.push([start, end])
  }
  return ranges
}

/**
 * How well `text` answers the query, strongest first:
 * - `exact`: the text is the query (case, diacritics and spacing aside),
 * - `prefix`: the text starts with the query's words in order,
 * - `phrase`: the query's words stand together, in order, somewhere in the text,
 * - `words`: every query word starts some word in the text,
 * - null: at least one word is missing.
 */
export type SearchMatchKind = 'exact' | 'prefix' | 'phrase' | 'words'

export function searchMatchKind(text: string, words: readonly string[]): SearchMatchKind | null {
  if (words.length === 0) return null
  const folded = foldForSearch(text).folded
  if (!words.every((word) => new RegExp(wordStart(word), 'u').test(folded))) return null
  const textWords = folded.match(WORD) ?? []
  if (textWords.length === words.length && textWords.every((word, index) => word === words[index])) return 'exact'
  const phrase = words.map(escape).join(`${NOT_WORD}+`)
  if (new RegExp(`^${NOT_WORD}*${phrase}`, 'u').test(folded)) return 'prefix'
  if (new RegExp(`(?<![\\p{L}\\p{N}])${phrase}`, 'u').test(folded)) return 'phrase'
  return 'words'
}

/**
 * One line of `text` around its first match, cut at word edges with an ellipsis where
 * it was cut. Whitespace runs collapse, so a match deep in a multi-line note still
 * reads as one sentence. Undefined when no word matches.
 */
export function searchExcerpt(text: string, words: readonly string[], before = 50, after = 110): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim()
  const first = searchMatches(flat, words)[0]
  if (first === undefined) return undefined
  let start = Math.max(0, first[0] - before)
  let end = Math.min(flat.length, first[1] + after)
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    start = space === -1 || space >= first[0] ? start : space + 1
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end)
    end = space <= first[1] ? end : space
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
