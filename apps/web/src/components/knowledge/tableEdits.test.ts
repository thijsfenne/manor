import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { livePreviewExtensions } from './livePreview'
import {
  appendColumn, appendRow, deleteColumn, deleteRow, insertColumn, insertRow, minimalChange, tableDeletion, tableShape,
} from './tableEdits'

const compact = '|A|B|\n|---|---|\n|1|2|'
const padded = '| Name  | Qty |\n| ----- | --- |\n| Apple | 3   |'
const marked = '| L | C | R |\n| :--- | :---: | ---: |\n| a \\| b | `x\\|y` | **z** |'
const oneColumn = '| Only |\n| --- |\n| a |'
const headerOnly = '| A | B |\n| --- | --- |'
const quoted = '> | A | B |\n> | --- | --- |\n> | 1 | 2 |'
const crlf = '| A | B |\r\n| --- | --- |\r\n| 1 | 2 |'
const bare = 'A | B\n--- | ---\n1 | 2'

/** The note's own parser still reads the result as one table of the expected size. */
function readsAs(text: string, rows: number, columns: number) {
  const state = EditorState.create({ doc: `${text}\n\nAfter`, extensions: livePreviewExtensions() })
  const top = ensureSyntaxTree(state, state.doc.length, Infinity)!.topNode.firstChild!
  expect([top.name, top.from, top.to]).toEqual(['Table', 0, text.length])
  expect(tableShape(text)).toEqual({ rows, columns })
}

describe('Table rows', () => {
  it('inserts an empty row in the table\'s own spacing and moves the caret into it', () => {
    expect(insertRow(compact, 1, 'below')).toEqual({ text: `${compact}\n|||`, focus: { row: 2, column: 0 } })
    expect(insertRow(padded, 0, 'below')).toEqual({
      text: '| Name  | Qty |\n| ----- | --- |\n|       |     |\n| Apple | 3   |',
      focus: { row: 1, column: 0 },
    })
    expect(insertRow(marked, 1, 'above')!.text)
      .toBe('| L | C | R |\n| :--- | :---: | ---: |\n|  |  |  |\n| a \\| b | `x\\|y` | **z** |')
    expect(insertRow(headerOnly, 0, 'below')).toEqual({ text: `${headerOnly}\n|  |  |`, focus: { row: 1, column: 0 } })
    expect(appendRow(oneColumn)!.text).toBe(`${oneColumn}\n|  |`)
    expect(insertRow(crlf, 1, 'below')!.text).toBe(`${crlf}\r\n|  |  |`)
    expect(insertRow(bare, 1, 'above')!.text).toBe('A | B\n--- | ---\n|  |  |\n1 | 2')
    readsAs(insertRow(compact, 1, 'below')!.text, 3, 2)
    readsAs(insertRow(padded, 0, 'below')!.text, 3, 2)
    readsAs(insertRow(bare, 1, 'above')!.text, 3, 2)
  })

  it('keeps the header first and never deletes it as a row', () => {
    expect(insertRow(compact, 0, 'above')).toBeNull()
    expect(deleteRow(compact, 0)).toBeNull()
    expect(deleteRow(headerOnly, 0)).toBeNull()
  })

  it('deletes a body row and leaves every other line as it was', () => {
    expect(deleteRow(compact, 1)).toEqual({ text: '|A|B|\n|---|---|', focus: null })
    expect(deleteRow(padded, 1)!.text).toBe('| Name  | Qty |\n| ----- | --- |')
    expect(deleteRow(crlf, 1)!.text).toBe('| A | B |\r\n| --- | --- |')
    const three = `${marked}\n| d | e | f |`
    expect(deleteRow(three, 1)!.text).toBe('| L | C | R |\n| :--- | :---: | ---: |\n| d | e | f |')
    expect(deleteRow(three, 2)!.text).toBe(marked)
    expect(deleteRow(three, 3)).toBeNull()
  })
})

describe('Table columns', () => {
  it('inserts an empty column with the default alignment and moves the caret to its header', () => {
    expect(insertColumn(compact, 0, 'left')).toEqual({ text: '||A|B|\n|---|---|---|\n||1|2|', focus: { row: 0, column: 0 } })
    expect(appendColumn(compact)).toEqual({ text: '|A|B||\n|---|---|---|\n|1|2||', focus: { row: 0, column: 2 } })
    expect(insertColumn(padded, 0, 'right')!.text).toBe('| Name  |     | Qty |\n| ----- | --- | --- |\n| Apple |     | 3   |')
    expect(insertColumn(marked, 1, 'left')!.text)
      .toBe('| L |  | C | R |\n| :--- | --- | :---: | ---: |\n| a \\| b |  | `x\\|y` | **z** |')
    expect(insertColumn(oneColumn, 0, 'left')!.text).toBe('|  | Only |\n| --- | --- |\n|  | a |')
    expect(insertColumn(headerOnly, 1, 'right')!.text).toBe('| A | B |  |\n| --- | --- | --- |')
    expect(insertColumn(crlf, 0, 'right')!.text).toBe('| A |  | B |\r\n| --- | --- | --- |\r\n| 1 |  | 2 |')
    readsAs(insertColumn(compact, 0, 'left')!.text, 2, 3)
    readsAs(appendColumn(compact)!.text, 2, 3)
    readsAs(insertColumn(padded, 0, 'right')!.text, 2, 3)
    readsAs(insertColumn(marked, 1, 'left')!.text, 2, 4)
    readsAs(appendColumn(bare)!.text, 2, 3)
  })

  it('leaves a row GFM already pads alone', () => {
    const short = '| A | B | C |\n| --- | --- | --- |\n| 1 |'
    expect(appendColumn(short)!.text).toBe('| A | B | C |  |\n| --- | --- | --- | --- |\n| 1 |')
    expect(insertColumn(short, 0, 'left')!.text).toBe('|  | A | B | C |\n| --- | --- | --- | --- |\n|  | 1 |')
  })

  it('deletes a column, alignment marker included, and keeps the rest byte for byte', () => {
    expect(deleteColumn(compact, 0)).toEqual({ text: '|B|\n|---|\n|2|', focus: null })
    expect(deleteColumn(padded, 1)!.text).toBe('| Name  |\n| ----- |\n| Apple |')
    expect(deleteColumn(marked, 1)!.text).toBe('| L | R |\n| :--- | ---: |\n| a \\| b | **z** |')
    expect(deleteColumn(marked, 2)!.text).toBe('| L | C |\n| :--- | :---: |\n| a \\| b | `x\\|y` |')
    expect(deleteColumn(crlf, 0)!.text).toBe('| B |\r\n| --- |\r\n| 2 |')
    expect(deleteColumn(bare, 1)!.text).toBe('|A |\n|--- |\n|1 |')
    readsAs(deleteColumn(marked, 1)!.text, 2, 2)
    readsAs(deleteColumn(bare, 1)!.text, 2, 1)
  })

  it('never deletes the last column', () => {
    expect(deleteColumn(oneColumn, 0)).toBeNull()
  })
})

describe('Tables the edits decline', () => {
  it('leaves a table in a quote or callout untouched', () => {
    const callout = '> [!note]\n> | A | B |\n> | --- | --- |'
    for (const text of [quoted, callout.slice(callout.indexOf('\n') + 1)]) {
      expect(tableShape(text)).toBeNull()
      expect([
        insertRow(text, 0, 'below'), appendRow(text), insertColumn(text, 0, 'left'), appendColumn(text),
        deleteRow(text, 1), deleteColumn(text, 0),
      ]).toEqual([null, null, null, null, null, null])
    }
  })

  it('declines text that is not a table', () => {
    expect(tableShape('Just a line')).toBeNull()
    expect(tableShape('| A | B |\n| nope | --- |')).toBeNull()
  })
})

describe('Deleting a whole table', () => {
  const remove = (doc: string, table: string) => {
    const from = doc.indexOf(table)
    const range = tableDeletion(doc, from, from + table.length)
    return doc.slice(0, range.from) + doc.slice(range.to)
  }

  it('takes its lines and one blank line around it, nothing more', () => {
    expect(remove(`# Overview\n\n${marked}\n\nAfter`, marked)).toBe('# Overview\n\nAfter')
    expect(remove(`Intro\n\n${marked}`, marked)).toBe('Intro\n')
    expect(remove(`${marked}\n\nAfter`, marked)).toBe('After')
    expect(remove(`Intro\n\n${marked}\nAfter`, marked)).toBe('Intro\n\nAfter')
    expect(remove(`Intro\r\n\r\n${crlf}\r\n\r\nAfter`, crlf)).toBe('Intro\r\n\r\nAfter')
  })
})

describe('Writing a structural edit back', () => {
  it('changes only the bytes that differ', () => {
    const edit = insertRow(marked, 1, 'above')!.text
    const change = minimalChange(marked, edit)
    expect(marked.slice(0, change.from) + change.insert + marked.slice(change.to)).toBe(edit)
    expect(change.to - change.from).toBe(0)
    expect(minimalChange('abc', 'abc')).toEqual({ from: 3, to: 3, insert: '' })
  })
})
