/**
 * Keeps a list's row objects across a rebuild. The transcript is projected again
 * from all its events whenever one event lands, which is cheap, but every row is then a
 * new object and every mounted row redraws. A rebuilt row that says exactly what the
 * previous one with its key said is replaced by that previous object, so a list that
 * compares rows by identity redraws only what changed.
 *
 * Nothing here knows what a row depends on. A row is reused only when its whole
 * content is the same, so a later event that changes an earlier row always shows.
 */

type Keyed = { key: string }

/**
 * Whether two values say the same thing. Objects that are the same object are equal
 * without a look inside, which is what makes this cheap here: a rebuilt row is new, but
 * the events, images and edits it points at are the ones the previous row pointed at.
 *
 * For plain data: primitives, arrays, plain objects, Maps and Sets. Anything else, a
 * Date or a class instance, is equal only to itself, which costs a redraw at worst.
 */
export function sameStructure(left: unknown, right: unknown, seen: Map<object, object> = new Map()): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  // A pair already being compared further up is taken as equal: a cycle cannot differ on its own.
  if (seen.get(left) === right) return true
  seen.set(left, right)
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) if (!sameStructure(left[index], right[index], seen)) return false
    return true
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false
    for (const [key, value] of left) if (!right.has(key) || !sameStructure(value, right.get(key), seen)) return false
    return true
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false
    for (const value of left) if (!right.has(value)) return false
    return true
  }
  const prototype = Object.getPrototypeOf(left)
  if (prototype !== Object.getPrototypeOf(right) || (prototype !== Object.prototype && prototype !== null)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false
    if (!sameStructure((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], seen)) return false
  }
  return true
}

/**
 * `next` with every row that equals the previous row of its key replaced by that
 * previous object. Returns `previous` itself when nothing changed at all, and `next`
 * itself when nothing could be reused.
 */
export function reuseRows<Row extends Keyed>(previous: readonly Row[] | undefined, next: Row[]): Row[] {
  if (previous === undefined || previous.length === 0 || previous === next) return next
  const held = new Map<string, Row>()
  for (const row of previous) held.set(row.key, row)
  let reused = 0
  const rows = next.map((row) => {
    const before = held.get(row.key)
    if (before === undefined || (before !== row && !sameStructure(before, row))) return row
    // One object stands in one place: a list keyed by row must never see it twice.
    held.delete(row.key)
    reused += 1
    return before
  })
  if (reused === 0) return next
  return reused === previous.length && rows.length === previous.length && rows.every((row, index) => row === previous[index])
    ? previous as Row[]
    : rows
}

/**
 * The previous rows of one list, for a consumer that rebuilds them outside this
 * module. Hold one per list (one per mounted transcript) and pass every rebuilt list
 * through `reuse`. Passing the same list again gives the same answer.
 */
export function createRowMemory<Row extends Keyed>(): { reuse(rows: Row[]): Row[] } {
  let previous: Row[] | undefined
  return {
    reuse(rows) {
      previous = reuseRows(previous, rows)
      return previous
    },
  }
}

/**
 * The last value of something derived from the rows, for a consumer that rebuilds it
 * on every change of the rows: `keep` hands back the previous value while the new one
 * says the same. Hold one per derived value.
 */
export function createValueMemory<Value>(): { keep(value: Value): Value } {
  let previous: { value: Value } | undefined
  return {
    keep(value) {
      if (previous === undefined || !sameStructure(previous.value, value)) previous = { value }
      return previous.value
    },
  }
}
