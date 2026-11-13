/** Cell spans exclude the structural pipes, including optional outer pipes. */
function rowCells(source: string, from: number, to: number) {
  const cells: { from: number; to: number }[] = []
  let start = from
  for (let at = from; at < to; at += 1) {
    if (source[at] === '\\') {
      at += 1
    } else if (source[at] === '|') {
      cells.push({ from: start, to: at })
      start = at + 1
    }
  }
  cells.push({ from: start, to })
  if (cells.length > 1 && source.slice(cells[0]!.from, cells[0]!.to).trim() === '') cells.shift()
  if (cells.length > 1 && source.slice(cells.at(-1)!.from, cells.at(-1)!.to).trim() === '') cells.pop()
  return cells
}

export interface TableCellAddress {
  from: number
  to: number
  column: number
}

function cellRange(source: string, address: TableCellAddress) {
  const cell = rowCells(source, address.from, address.to)[address.column]
  if (cell === undefined) return undefined
  const text = source.slice(cell.from, cell.to)
  const from = cell.from + text.length - text.trimStart().length
  return { from, to: Math.max(from, cell.to - (text.length - text.trimEnd().length)) }
}

export function tableCellValue(source: string, address: TableCellAddress) {
  const cell = cellRange(source, address)
  return cell === undefined ? '' : source.slice(cell.from, cell.to).replace(/\\\|/g, '|')
}

/** Keep a cell edit on one row, with literal pipes escaped for GFM. */
export function tableCellChange(source: string, address: TableCellAddress, value: string) {
  const insert = value.replace(/[\r\n]+/g, ' ').replace(/\\*\|/g, (pipe) => pipe.length % 2 === 1 ? `\\${pipe}` : pipe)
  const cells = rowCells(source, address.from, address.to)
  const cell = cells[address.column]
  if (cell !== undefined) {
    const previous = source.slice(cell.from, cell.to)
    // Canonicalise padding only in the edited cell, so typing a space cannot keep
    // adding to the source's padding on every subsequent keystroke.
    return { ...cell, insert: `${/^\s/.test(previous) ? ' ' : ''}${insert}${/\s$/.test(previous) ? ' ' : ''}` }
  }

  // GFM supplies empty cells for short rows. Materialise just the missing columns.
  const missing = address.column - cells.length
  const trailingPipe = source.slice(cells.at(-1)?.to ?? address.to, address.to).trim() === '|'
  return {
    from: address.to,
    to: address.to,
    insert: `${trailingPipe ? '' : ' |'}${' |'.repeat(Math.max(0, missing))} ${insert}${trailingPipe ? ' |' : ''}`,
  }
}
