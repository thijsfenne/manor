/**
 * Structural edits on one markdown table: table text in, new table text out, plus the
 * cell that should take the caret. Rows are counted the way the reader sees them, 0 is
 * the header and 1 onwards the body; the delimiter line is not a row.
 *
 * Nothing is re-serialised. A row keeps its own bytes and only gains or loses whole
 * cell segments at pipe boundaries, so cell text, alignment markers, escaped pipes,
 * inline marks, padding and line endings outside the touched segment stay as written.
 */

export interface CellFocus {
  row: number
  column: number
}

export interface TableEdit {
  text: string
  /** The cell to edit next, or null to leave focus where it is. */
  focus: CellFocus | null
}

export interface TableShape {
  rows: number
  columns: number
}

interface Line {
  /** Indentation and the leading pipe, when there is one. */
  prefix: string
  /** Raw segments between structural pipes, padding included. */
  cells: string[]
  /** The trailing pipe and anything after it, or '' when the row has no trailing pipe. */
  suffix: string
  /** The separator that followed the line in the source, '' for the last one. */
  eol: string
}

interface Table {
  lines: Line[]
  columns: number
  eol: string
  /** Every row has every cell and each column is padded to one width. */
  aligned: boolean
  /** Cells carry a space inside their pipes, `| a |` rather than `|a|`. */
  spaced: boolean
}

const DELIMITER_CELL = /^\s*:?-+:?\s*$/

function parseLine(text: string, eol: string): Line {
  const pipes: number[] = []
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '\\') at += 1
    else if (text[at] === '|') pipes.push(at)
  }
  const first = text.search(/\S/)
  const last = text.trimEnd().length - 1
  const leading = first >= 0 && pipes[0] === first
  const trailing = last >= 0 && pipes.at(-1) === last && !(leading && pipes.length === 1)
  const start = leading ? first + 1 : 0
  const end = trailing ? last : text.length
  const inner = pipes.filter((pipe) => pipe >= start && pipe < end)
  const cells: string[] = []
  let from = start
  for (const pipe of inner) {
    cells.push(text.slice(from, pipe))
    from = pipe + 1
  }
  cells.push(text.slice(from, end))
  return { prefix: text.slice(0, start), cells, suffix: text.slice(end), eol }
}

function lineText(line: Line) {
  return line.prefix + line.cells.join('|') + line.suffix
}

/** Null for anything this module will not edit: not a table, or a table inside a quote or callout. */
function parse(text: string): Table | null {
  const parts = text.split(/(\r?\n)/)
  const lines: Line[] = []
  for (let index = 0; index < parts.length; index += 2) lines.push(parseLine(parts[index]!, parts[index + 1] ?? ''))
  if (lines.length < 2) return null
  if (parts.some((part, index) => index % 2 === 0 && /^\s*>/.test(part))) return null
  const header = lines[0]!
  const delimiter = lines[1]!
  const columns = header.cells.length
  if (!lineText(header).includes('|') || delimiter.cells.length !== columns) return null
  if (!delimiter.cells.every((cell) => DELIMITER_CELL.test(cell))) return null
  const widths = header.cells.map((cell) => cell.length)
  const aligned = lines.every((line) => line.cells.length === columns && line.cells.every((cell, column) => cell.length === widths[column]))
  const spaced = delimiter.cells.filter((cell) => /^\s/.test(cell)).length * 2 >= columns
  const eol = parts.find((part, index) => index % 2 === 1 && part !== '') ?? '\n'
  return { lines, columns, eol, aligned, spaced }
}

function serialise(lines: Line[]) {
  return lines.map((line) => lineText(line) + line.eol).join('')
}

/** `| --- |` or `|---|`, the narrowest default delimiter in the table's own spacing. */
function newColumnWidth(table: Table) {
  return table.spaced ? 5 : 3
}

/** An empty cell of `width` when the table is aligned, otherwise in its plain spacing. */
function blankCell(table: Table, width: number) {
  if (table.aligned) return ' '.repeat(width)
  return table.spaced ? '  ' : ''
}

const rowCell = (table: Table, column: number) => blankCell(table, table.lines[0]!.cells[column]!.length)
const emptyCell = (table: Table) => blankCell(table, newColumnWidth(table))

const lineOf = (row: number) => (row === 0 ? 0 : row + 1)

export function tableShape(text: string): TableShape | null {
  const table = parse(text)
  return table === null ? null : { rows: table.lines.length - 1, columns: table.columns }
}

/** A new empty body row above or below `row`. The header always stays the first row. */
export function insertRow(text: string, row: number, side: 'above' | 'below'): TableEdit | null {
  const table = parse(text)
  if (table === null) return null
  const rows = table.lines.length - 1
  if (row < 0 || row >= rows || (row === 0 && side === 'above')) return null
  const target = side === 'above' ? row : row + 1
  const header = table.lines[0]!
  const lead = header.prefix.includes('|')
  const trail = header.suffix.includes('|')
  // The header's own indentation sits outside the table's range; the delimiter's does not.
  const indent = /^\s*/.exec(lineText(table.lines[1]!))![0]
  const line: Line = {
    // Pipes as the header has them, but a blank row needs a pipe at its edge to stay a row.
    prefix: lead || !trail ? `${indent}|` : indent,
    cells: Array.from({ length: table.columns }, (_, column) => rowCell(table, column)),
    suffix: trail || !lead ? '|' : '',
    eol: table.eol,
  }
  const lines = [...table.lines]
  const at = lineOf(target)
  if (at === lines.length) {
    lines[at - 1] = { ...lines[at - 1]!, eol: table.eol }
    line.eol = ''
  }
  lines.splice(at, 0, line)
  return { text: serialise(lines), focus: { row: target, column: 0 } }
}

export function appendRow(text: string): TableEdit | null {
  const shape = tableShape(text)
  return shape === null ? null : insertRow(text, shape.rows - 1, 'below')
}

/** A new column with an empty header and the default alignment, left or right of `column`. */
export function insertColumn(text: string, column: number, side: 'left' | 'right'): TableEdit | null {
  const table = parse(text)
  if (table === null || column < 0 || column >= table.columns) return null
  const target = side === 'left' ? column : column + 1
  const width = newColumnWidth(table)
  const delimiter = table.spaced ? ` ${'-'.repeat(width - 2)} ` : '-'.repeat(width)
  const lines = table.lines.map((line, index) => {
    const count = line.cells.length
    // GFM fills a short row with empty cells; a column past its end needs nothing.
    if (target >= count && count < table.columns) return line
    const cells = [...line.cells]
    cells.splice(target, 0, index === 1 ? delimiter : emptyCell(table))
    // A last cell without a trailing pipe would be read as trailing space.
    const suffix = target === count && line.suffix === '' ? '|' : line.suffix
    return { ...line, cells, suffix }
  })
  return { text: serialise(lines), focus: { row: 0, column: target } }
}

export function appendColumn(text: string): TableEdit | null {
  const shape = tableShape(text)
  return shape === null ? null : insertColumn(text, shape.columns - 1, 'right')
}

/** Removes a body row. The header is not a row that can go: that is deleting the table. */
export function deleteRow(text: string, row: number): TableEdit | null {
  const table = parse(text)
  if (table === null || row < 1 || row >= table.lines.length - 1) return null
  const lines = [...table.lines]
  const at = lineOf(row)
  if (at === lines.length - 1) lines[at - 1] = { ...lines[at - 1]!, eol: lines[at]!.eol }
  lines.splice(at, 1)
  return { text: serialise(lines), focus: null }
}

/** Removes a column. The last column cannot go: that is deleting the table. */
export function deleteColumn(text: string, column: number): TableEdit | null {
  const table = parse(text)
  if (table === null || table.columns < 2 || column < 0 || column >= table.columns) return null
  const lines = table.lines.map((line) => {
    if (column >= line.cells.length) return line
    const cells = line.cells.filter((_, index) => index !== column)
    // One cell and no pipe at all would no longer be a table row.
    if (cells.length === 1 && !line.prefix.includes('|') && !line.suffix.includes('|')) {
      return { ...line, cells, prefix: `${line.prefix}|`, suffix: '|' }
    }
    return { ...line, cells }
  })
  return { text: serialise(lines), focus: null }
}

/**
 * The document range that deleting a table removes: its whole lines, and one of the
 * blank lines around it, so the blocks on either side keep a single blank line between.
 */
export function tableDeletion(doc: string, from: number, to: number) {
  let start = doc.lastIndexOf('\n', from - 1) + 1
  if (doc.slice(start, from).trim() !== '') start = from
  let end = to
  const newline = (at: number) => (doc.startsWith('\r\n', at) ? 2 : doc[at] === '\n' ? 1 : 0)
  if (newline(end) > 0) {
    end += newline(end)
    const blankAbove = /\n\r?\n$/.test(doc.slice(0, start)) || start === 0
    if (blankAbove && newline(end) > 0) end += newline(end)
  } else if (/\r?\n\r?\n$/.test(doc.slice(0, start))) {
    // The table ended the note: take the blank line above it with it.
    start -= doc.slice(0, start).endsWith('\r\n') ? 2 : 1
  }
  return { from: start, to: end }
}

/** One change that turns `before` into `after`, touching only the bytes that differ. */
export function minimalChange(before: string, after: string) {
  let head = 0
  const shortest = Math.min(before.length, after.length)
  while (head < shortest && before[head] === after[head]) head += 1
  let tail = 0
  while (tail < shortest - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1
  return { from: head, to: before.length - tail, insert: after.slice(head, after.length - tail) }
}
