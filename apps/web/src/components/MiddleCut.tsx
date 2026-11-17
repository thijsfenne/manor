/** How much of the end stays when a name is cut: an extension plus the characters before it. */
const KEPT_END = 12

/**
 * Splits a name so the part kept at the end is never more than half of it. A line break
 * reads as a space, so the name stays on one line.
 */
export function splitForMiddleCut(text: string): [head: string, tail: string] {
  const characters = Array.from(text.replace(/[\r\n]+/g, ' '))
  const kept = Math.min(KEPT_END, Math.floor(characters.length / 2))
  return [characters.slice(0, characters.length - kept).join(''), characters.slice(characters.length - kept).join('')]
}

/**
 * A one-line file name that is cut in the middle, so the extension and a version at the
 * end stay readable. Use it in place of a `truncate` span; `className` styles the line.
 * The hover tooltip comes from `overflowTitles`, which knows this mark.
 */
export function MiddleCut({ text, className = '' }: { text: string; className?: string }) {
  const [head, tail] = splitForMiddleCut(text)
  return (
    <span className={`flex min-w-0 ${className}`} data-middle-cut="">
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">{head}</span>
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </span>
  )
}
