import { EditorState, type Transaction } from '@codemirror/state'
import { history, undo, redo } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { livePreviewExtensions } from './livePreview'
import { TablePreview, tablePreviewField } from './tablePreview'
import { tableCellChange, tableCellValue } from './tableCells'
import { ContextMenu } from '../ui/ContextMenu'

// The real menu portals into the document; these tests only read what it is given.
vi.mock('../ui/ContextMenu', () => ({ ContextMenu: vi.fn(() => null) }))

const table = '| Company | Status | Note |\n| --- | :---: | ---: |\n| Example | **Open** | [Link](https://example.com) and `a\\|b` |'
const doc = `# Overview\n\n${table}\n\nAfter`
const note = () => EditorState.create({ doc, extensions: livePreviewExtensions() })

function tables(state: EditorState) {
  // EditorState's initial parse has a 20 ms budget. Complete it before asserting
  // decorations, then let the field observe the finished tree in a transaction.
  ensureSyntaxTree(state, state.doc.length, Infinity)
  state = state.update({}).state
  const found: { from: number; to: number; block: boolean }[] = []
  state.field(tablePreviewField).between(0, state.doc.length, (from, to, decoration) => {
    found.push({ from, to, block: decoration.spec.block })
  })
  return found
}

describe('Knowledge table preview', () => {
  it('replaces a whole table with one block without changing the note', () => {
    const state = note()
    expect(tables(state)).toEqual([{ from: doc.indexOf(table), to: doc.indexOf(table) + table.length, block: true }])
    expect(state.doc.toString()).toBe(doc)
  })

  it('finds the table after the initial parsing budget expires', () => {
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 21)
    let state: EditorState
    try { state = note() }
    finally { clock.mockRestore() }
    expect(tables(state)).toHaveLength(1)
  })

  it('keeps the table rendered when the document cursor or text changes', () => {
    let state = note()
    const at = doc.indexOf('Example')
    state = state.update({ selection: { anchor: at } }).state
    expect(tables(state)).toHaveLength(1)
    state = state.update({ changes: { from: at, to: at + 7, insert: 'Changed' } }).state
    state = state.update({ selection: { anchor: 0 } }).state
    expect(tables(state)).toHaveLength(1)
    expect(state.doc.toString()).toContain('Changed')
  })

  it('keeps the table rendered when a selection spans it', () => {
    const state = note().update({ selection: { anchor: 0, head: doc.length } }).state
    expect(tables(state)).toHaveLength(1)
  })

  it('does not replace table-shaped text inside a code fence', () => {
    const state = EditorState.create({ doc: `# Example\n\n\`\`\`md\n${table}\n\`\`\``, extensions: livePreviewExtensions() })
    expect(tables(state)).toEqual([])
  })

  it('renders columns, alignment, inline formatting and escaped pipes with source positions', () => {
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<TablePreview source={table} />) })
    const root = renderer.root
    expect(root.findAllByType('table')).toHaveLength(1)
    expect(root.findAllByType('th')).toHaveLength(3)
    const cells = root.findAllByType('td')
    expect(cells).toHaveLength(3)
    expect(cells[1]!.props.style.textAlign).toBe('center')
    expect(cells[2]!.props.style.textAlign).toBe('right')
    expect(root.findByType('strong').children).toEqual(['Open'])
    expect(root.findByType('a').props.href).toBe('https://example.com')
    expect(root.findByType('code').children).toEqual(['a|b'])
    expect(cells[0]!.props['data-source']).toBe(table.indexOf('| Example'))
    // A read-only preview never gains editable controls.
    expect(root.findAllByProps({ className: 'cm-manor-cell' }).every((cell) => cell.props.tabIndex === undefined)).toBe(true)
    act(() => renderer.unmount())
  })

  it('edits one cell without leaving the table or losing typed spaces', () => {
    let saved = table
    function Harness() {
      const [source, setSource] = useState(table)
      return <TablePreview source={source} onChange={(change) => {
        saved = source.slice(0, change.from) + change.insert + source.slice(change.to)
        setSource(saved)
      }} onUndo={() => setSource(table)} />
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<Harness />) })
    const cell = renderer.root.findAllByProps({ className: 'cm-manor-cell' })[3]!
    const target = {}
    act(() => cell.props.onFocus({ target, currentTarget: target }))
    expect(renderer.root.findByType('textarea').props.value).toBe('Example')
    for (const value of ['New ', 'New company']) {
      act(() => renderer.root.findByType('textarea').props.onChange({ target: { value } }))
      expect(renderer.root.findByType('textarea').props.value).toBe(value)
      // The hidden copy under the field is what sizes the cell, so it follows every keystroke.
      expect(renderer.root.findByProps({ className: 'cm-manor-cell-sizer' }).props.children).toBe(`${value}\u200b`)
      expect(renderer.root.findAllByType('table')).toHaveLength(1)
    }
    expect(saved).toBe(table.replace('Example', 'New company'))
    act(() => renderer.root.findByType('textarea').props.onKeyDown({
      key: 'z', metaKey: true, shiftKey: false, preventDefault() {},
    }))
    expect(renderer.root.findByType('textarea').props.value).toBe('Example')
    act(() => renderer.root.findByType('textarea').props.onBlur())
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0)
    act(() => renderer.unmount())
  })

  it('uses the document history for cell edits', () => {
    let state = EditorState.create({ doc: table, extensions: [history(), livePreviewExtensions()] })
    const address = { from: table.lastIndexOf('\n') + 1, to: table.length, column: 0 }
    state = state.update({ changes: tableCellChange(table, address, 'Updated') }).state
    const target = { get state() { return state }, dispatch: (transaction: Transaction) => { state = transaction.state } }
    expect(undo(target)).toBe(true)
    expect(state.doc.toString()).toBe(table)
    expect(redo(target)).toBe(true)
    expect(state.doc.toString()).toBe(table.replace('Example', 'Updated'))
  })
})

describe('Markdown cell writes', () => {
  function edit(row: string, column: number, value: string) {
    const change = tableCellChange(row, { from: 0, to: row.length, column }, value)
    return row.slice(0, change.from) + change.insert + row.slice(change.to)
  }

  it('preserves other cells, links and escaped pipes', () => {
    const row = '| **One** | [Two](https://example.com) | `a\\|b` |'
    expect(edit(row, 0, '**Changed**')).toBe(row.replace('**One**', '**Changed**'))
    expect(tableCellValue(row, { from: 0, to: row.length, column: 2 })).toBe('`a|b`')
    expect(edit(row, 2, '`a|b`')).toBe(row)
    expect(edit(row, 2, '`a\\|b`')).toBe(row)
    expect(edit(row, 1, 'left|right\nnext')).toBe('| **One** | left\\|right next | `a\\|b` |')
  })

  it('writes empty cells and fills missing cells without merging columns', () => {
    expect(edit('| One | | Three |', 1, 'Two')).toBe('| One | Two | Three |')
    expect(edit('One | Two', 2, 'Three')).toBe('One | Two | Three')
    expect(edit('| One |', 2, 'Three')).toBe('| One | | Three |')
    expect(edit('| One | Two |', 0, '')).toBe('|  | Two |')
  })
})

describe('Table structure from the widget', () => {
  const small = '| A | B |\n| --- | --- |\n| 1 | 2 |'

  function mount(initial: string) {
    const state = { saved: initial, deleted: false }
    function Harness() {
      const [source, setSource] = useState(initial)
      const apply = (change: { from: number; to: number; insert: string }) => setSource((current) => {
        state.saved = current.slice(0, change.from) + change.insert + current.slice(change.to)
        return state.saved
      })
      return <TablePreview source={source} onChange={apply} onReplace={apply} onDeleteTable={() => { state.deleted = true }} />
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<Harness />) })
    const cells = () => renderer.root.findAllByProps({ className: 'cm-manor-cell' })
    const focus = (index: number) => {
      const target = {}
      act(() => cells()[index]!.props.onFocus({ target, currentTarget: target }))
    }
    const key = (key: string, shiftKey = false) => act(() => renderer.root.findByType('textarea').props.onKeyDown({
      key, shiftKey, metaKey: false, ctrlKey: false, nativeEvent: { isComposing: false }, preventDefault() {}, currentTarget: { blur() {} },
    }))
    const menu = (index: number) => {
      act(() => cells()[index]!.props.onContextMenu({ clientX: 10, clientY: 20, preventDefault() {}, stopPropagation() {} }))
      return renderer.root.findByType(ContextMenu).props.items as { label: string; disabled?: boolean; tone?: string; onSelect: () => void }[]
    }
    return { renderer, state, cells, focus, key, menu }
  }

  it('offers every item, disabling the ones that do not apply to the cell', () => {
    const { renderer, menu } = mount(small)
    const offered = (index: number) => menu(index).map((item) => [item.label, item.disabled === true, item.tone ?? 'default'])
    expect(offered(0)).toEqual([
      ['Insert row above', true, 'default'],
      ['Insert row below', false, 'default'],
      ['Insert column left', false, 'default'],
      ['Insert column right', false, 'default'],
      ['Delete row', true, 'danger'],
      ['Delete column', false, 'danger'],
      ['Delete table', false, 'danger'],
    ])
    expect(offered(3).filter(([, disabled]) => disabled)).toEqual([])
    act(() => renderer.unmount())
    const single = mount('| Only |\n| --- |\n| a |')
    expect(single.menu(1).filter((item) => item.disabled).map((item) => item.label)).toEqual(['Delete column'])
    act(() => single.renderer.unmount())
  })

  it('runs the chosen edit and moves into the new cell', () => {
    const { renderer, state, menu } = mount(small)
    const above = menu(2).find((item) => item.label === 'Insert row above')!
    act(() => above.onSelect())
    expect(state.saved).toBe('| A | B |\n| --- | --- |\n|  |  |\n| 1 | 2 |')
    expect(renderer.root.findAllByType('textarea')).toHaveLength(1)
    expect(renderer.root.findByType('textarea').props.value).toBe('')
    const remove = menu(1).find((item) => item.label === 'Delete table')!
    act(() => remove.onSelect())
    expect(state.deleted).toBe(true)
    act(() => renderer.unmount())
  })

  it('moves with Tab and Enter, and grows a row past the last one', () => {
    const { renderer, state, focus, key } = mount(small)
    focus(2)
    key('Tab')
    expect(renderer.root.findByType('textarea').props.value).toBe('2')
    key('Tab', true)
    expect(renderer.root.findByType('textarea').props.value).toBe('1')
    key('Tab')
    key('Tab')
    expect(state.saved).toBe(`${small}\n|  |  |`)
    expect(renderer.root.findByType('textarea').props.value).toBe('')
    key('Enter')
    expect(state.saved).toBe(`${small}\n|  |  |\n|  |  |`)
    act(() => renderer.unmount())
  })

  it('adds a row or a column at the end from the strips', () => {
    const { renderer, state } = mount(small)
    act(() => renderer.root.findByProps({ 'aria-label': 'Add column' }).props.onClick())
    expect(state.saved).toBe('| A | B |  |\n| --- | --- | --- |\n| 1 | 2 |  |')
    act(() => renderer.root.findByProps({ 'aria-label': 'Add row' }).props.onClick())
    expect(state.saved).toBe('| A | B |  |\n| --- | --- | --- |\n| 1 | 2 |  |\n|  |  |  |')
    act(() => renderer.unmount())
  })
})
