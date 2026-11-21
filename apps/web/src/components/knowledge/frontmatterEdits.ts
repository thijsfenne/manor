import type { EditorState, TransactionSpec } from '@codemirror/state'
import { frontmatterRange, ownStep } from './noteSyntax'

/**
 * The note's properties as rows the property list edits, and the edits themselves.
 * Each edit rewrites only the lines of the property it touches, so every other byte
 * of the frontmatter (comments, key order, quoting) stays as the file wrote it.
 * The transactions skip the frontmatter guard in `noteCaret.ts` with `filter: false`;
 * nothing else may write inside the block.
 */

/** How a value is written: `key: a`, `key: [a, b]`, or a `- a` list under the key. */
export type PropertyShape = 'scalar' | 'inline' | 'block'

export interface PropertyRow {
  key: string
  /** Document line number of the `key:` line. */
  line: number
  /** Last document line that belongs to this property (its list items), inclusive. */
  last: number
  shape: PropertyShape
  values: string[]
  /** False for YAML this list cannot rewrite safely (nested maps, block scalars). */
  editable: boolean
}

const FIELD = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/
const KEY = /^[A-Za-z_][\w-]*$/
const LIST_ITEM = /^([ \t]*-[ \t]+)(.*)$/
/** Keys the vault reads as lists, so a new value is written as one. */
const LIST_KEYS: ReadonlySet<string> = new Set(['tags', 'aliases', 'cssclasses'])

/** A YAML scalar as its text: double quotes read with their escapes, single quotes with `''`. */
function unquote(value: string): string {
  const text = value.trim()
  if (/^".*"$/.test(text)) {
    try { return String(JSON.parse(text)) } catch { return text.slice(1, -1) }
  }
  return /^'.*'$/.test(text) ? text.slice(1, -1).replace(/''/g, "'") : text
}

/** One entry of a `[a, "b", 'c']` list: a quoted string, or text up to the next comma. */
const INLINE_ITEM = /\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]*?)\s*(?:,|$)/g

const inlineItems = (value: string): string[] =>
  [...value.replace(/^\[|\]$/g, '').matchAll(INLINE_ITEM)].map((match) => unquote(match[1] ?? '')).filter((entry) => entry !== '')

/** The rows of the note's frontmatter in file order, or null when it has none. */
export function propertyRows(state: EditorState): PropertyRow[] | null {
  const meta = frontmatterRange(state)
  if (meta === null) return null
  const doc = state.doc
  const first = doc.lineAt(meta.from).number + 1
  const close = doc.lineAt(meta.to).number
  const rows: PropertyRow[] = []
  let current: (PropertyRow & { items: string[]; other: boolean; raw: string }) | null = null
  let comment = false
  const finish = () => {
    if (current === null) return
    const { items, other, raw, ...row } = current
    const complex = other || /^[|>{&*!]/.test(raw.trim())
    // A list entry holding a comma cannot survive the `a, b` field, so its row only reads.
    const listRow = (shape: 'block' | 'inline', values: string[], fits: boolean) =>
      rows.push({ ...row, shape, values, editable: fits && !complex && !values.some((value) => value.includes(',')) })
    const scalar = unquote(raw)
    if (raw.trim() === '' && items.length > 0) listRow('block', items, true)
    else if (raw.trim().startsWith('[')) listRow('inline', inlineItems(raw.trim()), items.length === 0 && raw.trim().endsWith(']'))
    else rows.push({ ...row, shape: 'scalar', values: scalar === '' ? [] : [scalar], editable: !complex && items.length === 0 })
  }
  for (let number = first; number < close; number += 1) {
    const text = doc.line(number).text
    const field = FIELD.exec(text)
    if (field !== null) {
      finish()
      comment = false
      current = { key: field[1] as string, line: number, last: number, shape: 'scalar', values: [], editable: true, items: [], other: false, raw: field[2] ?? '' }
      continue
    }
    if (current === null) continue
    if (text.trim() === '') continue
    // A comment at the margin belongs to the row only if the row goes on after it.
    if (text.startsWith('#')) { comment = true; continue }
    // A key this list cannot read belongs to no row.
    if (!/^[ \t]/.test(text) && LIST_ITEM.exec(text) === null) {
      finish()
      current = null
      continue
    }
    if (comment) current.other = true
    current.last = number
    const item = LIST_ITEM.exec(text)
    if (item !== null && current.raw.trim() === '') {
      const value = unquote(item[2] ?? '')
      if (value !== '') current.items.push(value)
    } else {
      current.other = true
    }
  }
  finish()
  return rows
}

/** What the value field shows for a row: a list as `a, b`, a scalar as itself. */
export const propertyText = (row: PropertyRow): string => row.values.join(', ')

/** A plain scalar YAML would read as something else, or not at all. */
const NEEDS_QUOTES = /^[\s\-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|:$|\s$/

function scalarText(value: string): string {
  return NEEDS_QUOTES.test(value) ? JSON.stringify(value) : value
}

/** A list entry YAML would read as a boolean, null or number rather than the text it is. */
const NOT_TEXT = /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i

function itemText(value: string): string {
  return NEEDS_QUOTES.test(value) || NOT_TEXT.test(value) || /[,[\]{}]/.test(value) ? JSON.stringify(value) : value
}

/** A scalar keeps the quotes it was written with. */
function keepQuotes(raw: string, value: string): string {
  const quote = raw.trim().charAt(0)
  if (quote === '"' && raw.trim().endsWith('"')) return JSON.stringify(value)
  if (quote === "'" && raw.trim().endsWith("'")) return `'${value.replace(/'/g, "''")}'`
  return scalarText(value)
}

const splitList = (input: string): string[] => input.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')

function edit(state: EditorState, from: number, to: number, insert: string): TransactionSpec {
  return { changes: { from, to, insert }, filter: false, userEvent: 'input.property', annotations: ownStep }
}

/**
 * The value of `row` set to what the user typed. A list is typed as `a, b`; the
 * row keeps its shape. Null when nothing would change or the row is not editable.
 */
export function setPropertyValue(state: EditorState, row: PropertyRow, input: string): TransactionSpec | null {
  // Opening a field and leaving it untouched writes nothing, even where the value has edge spaces.
  if (!row.editable || input === propertyText(row)) return null
  const doc = state.doc
  const keyLine = doc.line(row.line)
  const raw = FIELD.exec(keyLine.text)?.[2] ?? ''
  const prefix = keyLine.text.slice(0, keyLine.text.length - raw.length).trimEnd()
  const nl = state.lineBreak
  const list = row.shape !== 'scalar' || (row.values.length === 0 && LIST_KEYS.has(row.key))
  const values = list ? splitList(input) : [input.trim()].filter((value) => value !== '')
  if (values.length === row.values.length && values.every((value, index) => value === row.values[index])) return null

  if (row.shape === 'block' || (list && row.shape === 'scalar')) {
    const firstItem = row.shape === 'block' ? LIST_ITEM.exec(doc.line(row.line + 1).text)?.[1] : undefined
    const bullet = firstItem ?? '  - '
    const items = values.map((value) => `${bullet}${itemText(value)}`)
    const end = doc.line(row.last).to
    return edit(state, keyLine.from, end, [prefix, ...items].join(nl))
  }
  if (row.shape === 'inline') {
    return edit(state, keyLine.from, keyLine.to, `${prefix} [${values.map(itemText).join(', ')}]`)
  }
  const value = values[0]
  return edit(state, keyLine.from, keyLine.to, value === undefined ? prefix : `${prefix} ${keepQuotes(raw, value)}`)
}

/** Why a new key cannot be added, or null when it can. */
export function propertyKeyError(rows: readonly PropertyRow[], key: string): string | null {
  if (!KEY.test(key)) return 'Use letters, digits, - or _, starting with a letter.'
  if (rows.some((row) => row.key === key)) return 'That property already exists.'
  return null
}

/** A new property at the end of the frontmatter. Null when the key is refused. */
export function addProperty(state: EditorState, key: string, input: string): TransactionSpec | null {
  const meta = frontmatterRange(state)
  const rows = propertyRows(state)
  const name = key.trim()
  if (meta === null || rows === null || propertyKeyError(rows, name) !== null) return null
  const close = state.doc.lineAt(meta.to)
  const nl = state.lineBreak
  let lines: string[]
  if (LIST_KEYS.has(name)) {
    const items = splitList(input)
    lines = items.length === 0 ? [`${name}:`] : [`${name}:`, ...items.map((value) => `  - ${itemText(value)}`)]
  } else {
    const value = input.trim()
    lines = [value === '' ? `${name}:` : `${name}: ${scalarText(value)}`]
  }
  return edit(state, close.from, close.from, lines.join(nl) + nl)
}

/** The property's lines gone, list items included. */
export function removeProperty(state: EditorState, row: PropertyRow): TransactionSpec {
  const from = state.doc.line(row.line).from
  const end = state.doc.line(row.last)
  return edit(state, from, Math.min(end.to + 1, state.doc.length), '')
}
