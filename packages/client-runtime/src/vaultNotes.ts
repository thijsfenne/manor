/**
 * How a `[[wikilink]]` finds its note. Obsidian's own rules, shared by the Mac and
 * the phone: a link written in the vault has to open the same note on both screens,
 * and a resolver that lived in one app would drift the day the other guessed.
 */

/**
 * Every way a note can be named, pointing at the note it means.
 *
 * Obsidian resolves `[[Some note]]` against the shortest unique path, so a link
 * written from anywhere in the vault finds it; the same link written as
 * `[[folder/Some note]]` has to work too. Both are entries here, lowercased,
 * because links are typed by hand and their case drifts.
 */
export function buildNoteIndex(paths: readonly string[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const path of paths) {
    const segments = path.split('/')
    for (let start = segments.length - 1; start >= 0; start -= 1) {
      const suffix = segments.slice(start).join('/')
      claim(index, suffix, path)
      claim(index, suffix.replace(/\.md$/i, ''), path)
    }
  }
  return index
}

/**
 * Two notes can answer to one name. Obsidian picks the shallower one, so this does
 * too, and settles a genuine tie alphabetically rather than on listing order — a
 * link that changes where it points when the tree is re-read is worse than one that
 * points somewhere arguable.
 */
function claim(index: Map<string, string>, key: string, path: string) {
  const lower = key.toLowerCase()
  const held = index.get(lower)
  if (held === undefined || depth(path) < depth(held) || (depth(path) === depth(held) && path < held)) {
    index.set(lower, path)
  }
}

const depth = (path: string) => path.split('/').length

/** The note a `[[target]]` means, or null when the vault has no such note. */
export function resolveNote(index: Map<string, string>, target: string): string | null {
  // `#heading` and `^block` point inside a note; the note is all this can open.
  const name = target.split(/[#^]/)[0]?.trim().replace(/^\.\//, '') ?? ''
  if (name === '') return null
  return index.get(name.toLowerCase()) ?? null
}

/** One `[[target|label]]`, as the two things a renderer needs from it. */
export interface Wikilink {
  target: string
  label: string
}

/**
 * What is inside one pair of brackets, split into where it points and what it reads
 * as; null when either half is empty, which is a pair of brackets and not a link.
 * Shared because the two renderers meet the syntax differently — the Mac walks an
 * mdast tree, the phone walks its own inline matches — and must not disagree about
 * what `[[a|]]` means.
 */
export function readWikilink(inner: string): Wikilink | null {
  const pipe = inner.indexOf('|')
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
  const label = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim()
  if (target === '' || label === '') return null
  return { target, label }
}
