/** One line of a project thread file as the Context panel draws it: a list item, or a run of prose. */
export interface FileLine {
  /** Stable while the text stays the same, so an inserted line leaves its neighbours mounted. */
  key: string
  text: string
  item: boolean
}

const BULLET = /^[-*+]\s/
/** What only reads right in the whole document: numbered items, fences, reference links. */
const WHOLE_DOCUMENT = /^(?:\d+[.)]\s|\s*(?:```|~~~)|\s*\[[^\]]+\]:)/

/**
 * Splits a thread file (preferences.md, notes.md) into the lines a write adds or
 * removes: each bullet with whatever is indented under it, and each heading or
 * paragraph. A line keeps its key while its text holds, so the panel can tell the line
 * the thread just wrote from the ones already there.
 *
 * Undefined for a file that holds anything drawn differently when cut into lines,
 * such as numbered items, fences, reference links or indented text after a blank line;
 * the panel then draws it whole, without line motion.
 */
export function fileLines(body: string): FileLine[] | undefined {
  const blocks: { text: string[]; item: boolean }[] = []
  let current: { text: string[]; item: boolean } | undefined
  for (const line of body.split(/\r?\n/)) {
    if (WHOLE_DOCUMENT.test(line)) return undefined
    if (line.trim() === '') {
      current = undefined
      continue
    }
    const indented = /^\s/.test(line)
    if (current === undefined && indented) return undefined
    if (current === undefined || (!indented && BULLET.test(line))) {
      current = { text: [], item: BULLET.test(line) }
      blocks.push(current)
    }
    current.text.push(line)
  }
  const texts = blocks.map((block) => block.text.join('\n'))
  const keys = lineKeys(texts)
  return blocks.map((block, index) => ({ key: keys[index]!, text: texts[index]!, item: block.item }))
}

/** Keys for rows that have only their text to go by, a repeated text counted apart. */
export function lineKeys(texts: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return texts.map((text) => {
    const count = seen.get(text) ?? 0
    seen.set(text, count + 1)
    return `${count}:${text}`
  })
}
