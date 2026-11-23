import type { Project } from '@manor/contracts'

// Apart from the icon table so the row selectors can read it without loading every glyph.

/**
 * Two letters for a project's name: the first letter of its first two words, or the
 * first two letters of a single word ("Shot Journal" is SJ, "Manor" is MA). Empty
 * when the name has no letter or digit, and the glyph stands in.
 */
export function projectLetters(name: string): string {
  // NFKC folds a ligature or a wide form into plain letters and joins an accent to its letter.
  const words = name.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []
  const [first = [], second] = words.map((word) => word.match(/[\p{L}\p{N}]\p{M}*/gu) ?? [])
  const letters = second === undefined ? first.slice(0, 2) : [first[0], second[0]]
  return letters.map((letter = '') => upper(letter)).join('')
}

/** One letter in capitals, kept as it is when its capital is longer (ß would read SS). */
function upper(letter: string): string {
  const capital = letter.toLocaleUpperCase()
  return Array.from(capital).length === Array.from(letter).length ? capital : letter
}

/** The letters a project wears in place of its glyph, or undefined while it wears no letters. */
export const markLetters = (project: Pick<Project, 'name' | 'letters'>) =>
  project.letters === true ? projectLetters(project.name) || undefined : undefined

/** A flattened row's `projectLetters`, left out while the project wears no letters. */
export function projectLettersField(project: Pick<Project, 'name' | 'letters'> | undefined): { projectLetters?: string } {
  const letters = project === undefined ? undefined : markLetters(project)
  return letters === undefined ? {} : { projectLetters: letters }
}
