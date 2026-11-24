import { redo, undo } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { StateField, Transaction, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { PlusSignIcon } from '@hugeicons/core-free-icons'
import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from '../Icon'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { ScrollFade } from '../ui/ScrollFade'
import { ownStep } from './noteSyntax'
import { tableCellChange, tableCellValue, type TableCellAddress } from './tableCells'
import {
  appendColumn, appendRow, deleteColumn, deleteRow, insertColumn, insertRow, minimalChange, tableDeletion, tableShape,
  type CellFocus, type TableEdit, type TableShape,
} from './tableEdits'

type TableChange = { from: number; to: number; insert: string }

interface TableEditing {
  source: string
  onChange?: (change: TableChange) => void
  onUndo?: (redo: boolean) => void
  onLayout?: () => void
  /** A structural edit (rows, columns), relative to the table, applied as its own undo step. */
  onReplace?: (change: TableChange) => void
  onDeleteTable?: () => void
  /** Escape: hand the caret back to the note, on the line after the table. */
  onLeave?: () => void
}

/** What a cell needs from the table to move, grow and open its menu. */
interface TableControls {
  request: (CellFocus & { nonce: number }) | null
  consumed: (nonce: number) => void
  move: (from: CellFocus, how: 'next' | 'previous' | 'down') => void
  openMenu: (at: CellFocus, x: number, y: number) => void
}

const TableContext = createContext<TableEditing>({ source: '' })
const ControlsContext = createContext<TableControls | null>(null)
const CellContext = createContext<(TableCellAddress & { row: number }) | null>(null)

/** The reader's row: 0 is the header, the delimiter line is skipped. */
function rowAt(source: string, offset: number) {
  let line = 0
  for (let at = source.indexOf('\n'); at !== -1 && at < offset; at = source.indexOf('\n', at + 1)) line += 1
  return line === 0 ? 0 : line - 1
}

function TableRow({ node, children, ...props }: ComponentPropsWithoutRef<'tr'> & ExtraProps) {
  const { source } = useContext(TableContext)
  const row = node?.position === undefined ? 0 : rowAt(source, node.position.start.offset ?? 0)
  let column = 0
  return (
    <tr {...props}>
      {Children.map(children, (child) => {
        if (!isValidElement(child) || node?.position === undefined) return child
        const address = { from: node.position.start.offset ?? 0, to: node.position.end.offset ?? 0, column: column++, row }
        return <CellContext.Provider value={address}>{child}</CellContext.Provider>
      })}
    </tr>
  )
}

function Cell({ children }: ComponentPropsWithoutRef<'div'>) {
  const { source, onChange, onUndo, onLayout, onLeave } = useContext(TableContext)
  const controls = useContext(ControlsContext)
  const address = useContext(CellContext)
  const box = useRef<HTMLDivElement>(null)
  const ownEdit = useRef<string | null>(null)
  const [editingWidth, setEditingWidth] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const editable = onChange !== undefined && address !== null
  const editing = editable && editingWidth !== null
  const value = address === null ? '' : tableCellValue(source, address)

  // Keep spaces being typed, while still adopting undo and external note updates.
  useEffect(() => {
    if (editing && source !== ownEdit.current) {
      ownEdit.current = source
      setDraft(value)
    }
  }, [editing, source, value])

  // The sizer under the field sets the cell's size, so a height change is the table's too.
  useEffect(() => {
    if (editing) onLayout?.()
  }, [editing, draft, onLayout])

  function edit() {
    if (editable && !editing) {
      ownEdit.current = source
      setDraft(value)
      setEditingWidth(box.current?.getBoundingClientRect().width ?? 0)
    }
  }

  // Another cell, a key or a structural edit asked for this one: Tab, Enter, a new row.
  const request = controls?.request ?? null
  useEffect(() => {
    if (request === null || address === null) return
    if (request.row !== address.row || request.column !== address.column) {
      // Focus is moving elsewhere; stop editing here even before the blur arrives.
      if (editing) setEditingWidth(null)
      return
    }
    controls?.consumed(request.nonce)
    edit()
  })

  function openMenu(x: number, y: number) {
    if (controls !== null && address !== null) controls.openMenu(address, x, y)
  }

  return (
    <div
      ref={box}
      className="cm-manor-cell"
      tabIndex={editable && !editing ? 0 : undefined}
      style={editing ? { minWidth: editingWidth ?? undefined } : undefined}
      onFocus={(event) => { if (event.target === event.currentTarget) edit() }}
      onClick={(event) => { if (!(event.target instanceof Element) || event.target.closest('a') === null) edit() }}
      onContextMenu={controls === null ? undefined : (event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY)
      }}
    >
      {editing ? (
        <>
        {/* The text as it would lay out, which sizes the cell; the field lies over it. A
            textarea's own intrinsic width (its default columns) never reaches the table. */}
        <span className="cm-manor-cell-sizer" aria-hidden="true">{`${draft}\u200b`}</span>
        <textarea
          autoFocus
          aria-label="Edit table cell"
          rows={1}
          value={draft}
          // A field that mounts focused starts with its caret before the text, so typing
          // after a click on a cell went in front of what the cell held.
          onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
          onChange={(event) => {
            const next = event.target.value.replace(/[\r\n]+/g, ' ')
            const change = tableCellChange(source, address, next)
            ownEdit.current = source.slice(0, change.from) + change.insert + source.slice(change.to)
            setDraft(next)
            onChange(change)
          }}
          onBlur={() => setEditingWidth(null)}
          onKeyDown={(event) => {
            const enter = event.key === 'Enter' && !event.nativeEvent.isComposing
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
              event.preventDefault()
              onUndo?.(event.shiftKey)
            } else if (event.key === 'Tab' && controls !== null) {
              event.preventDefault()
              controls.move(address, event.shiftKey ? 'previous' : 'next')
            } else if (enter && controls !== null) {
              event.preventDefault()
              controls.move(address, 'down')
            } else if (event.key === 'Escape' || enter) {
              event.preventDefault()
              event.currentTarget.blur()
              if (event.key === 'Escape') onLeave?.()
            } else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
              event.preventDefault()
              const bounds = box.current?.getBoundingClientRect()
              openMenu((bounds?.left ?? 0) + 8, bounds?.bottom ?? 0)
            }
          }}
        />
        </>
      ) : children}
    </div>
  )
}

const components: Components = {
  tr: TableRow,
  th: ({ node, children, ...props }) => (
    <th {...props} data-source={node?.position?.start.offset}><Cell>{children}</Cell></th>
  ),
  td: ({ node, children, ...props }) => (
    <td {...props} data-source={node?.position?.start.offset}><Cell>{children}</Cell></td>
  ),
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  // Images remain text so a table cannot change height after an unmeasured load.
  img: ({ alt }) => <span>{alt}</span>,
}
const plugins = [remarkGfm]
const roots = new WeakMap<HTMLElement, Root>()

/**
 * The right-click menu of one cell. Every item is always listed; the ones that do not
 * apply here are disabled. The header is never deleted as a row and the last column
 * never as a column: both are what Delete table is for.
 */
export function tableMenuItems(
  shape: TableShape,
  at: CellFocus,
  run: { edit: (edit: TableEdit | null) => void; deleteTable?: (() => void) | undefined; source: string },
): ContextMenuItem[] {
  const { edit, deleteTable, source } = run
  const header = at.row === 0
  return [
    { label: 'Insert row above', disabled: header, onSelect: () => edit(insertRow(source, at.row, 'above')) },
    { label: 'Insert row below', onSelect: () => edit(insertRow(source, at.row, 'below')) },
    { label: 'Insert column left', onSelect: () => edit(insertColumn(source, at.column, 'left')) },
    { label: 'Insert column right', onSelect: () => edit(insertColumn(source, at.column, 'right')) },
    { label: 'Delete row', tone: 'danger', separatorBefore: true, disabled: header, onSelect: () => edit(deleteRow(source, at.row)) },
    { label: 'Delete column', tone: 'danger', disabled: shape.columns < 2, onSelect: () => edit(deleteColumn(source, at.column)) },
    { label: 'Delete table', tone: 'danger', disabled: deleteTable === undefined, onSelect: () => deleteTable?.() },
  ]
}

export function TablePreview({ source, onLayout, ...editing }: TableEditing) {
  useEffect(() => { onLayout?.() }, [onLayout, source])
  const shape = useMemo(() => tableShape(source), [source])
  const [request, setRequest] = useState<TableControls['request']>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; at: CellFocus } | null>(null)
  const nonce = useRef(0)
  const { onReplace, onDeleteTable } = editing
  const structural = editing.onChange !== undefined && onReplace !== undefined && shape !== null

  function focusCell(focus: CellFocus) {
    nonce.current += 1
    setRequest({ ...focus, nonce: nonce.current })
  }

  function apply(edit: TableEdit | null, focus = edit?.focus ?? null) {
    if (edit === null || onReplace === undefined) return
    onReplace(minimalChange(source, edit.text))
    if (focus !== null) focusCell(focus)
  }

  const controls: TableControls | null = !structural ? null : {
    request,
    consumed: (done) => setRequest((current) => (current?.nonce === done ? null : current)),
    openMenu: (at, x, y) => setMenu({ x, y, at: { row: at.row, column: at.column } }),
    move: (at, how) => {
      if (how === 'previous') {
        if (at.column > 0) focusCell({ row: at.row, column: at.column - 1 })
        else if (at.row > 0) focusCell({ row: at.row - 1, column: shape.columns - 1 })
      } else if (how === 'next' && at.column + 1 < shape.columns) {
        focusCell({ row: at.row, column: at.column + 1 })
      } else if (at.row + 1 < shape.rows) {
        focusCell({ row: at.row + 1, column: how === 'next' ? 0 : at.column })
      } else {
        // Past the last row: Tab starts the new row at its first cell, Enter stays in its column.
        const added = appendRow(source)
        apply(added, added === null || added.focus === null ? null : { row: added.focus.row, column: how === 'next' ? 0 : at.column })
      }
    },
  }

  const table = <ReactMarkdown remarkPlugins={plugins} components={components}>{source}</ReactMarkdown>
  return (
    <TableContext.Provider value={{ source, ...editing, ...(onLayout === undefined ? {} : { onLayout }) }}>
      <ControlsContext.Provider value={controls}>
        {!structural ? <ScrollFade>{table}</ScrollFade> : (
          <div className="cm-manor-table-frame">
            <ScrollFade className="cm-manor-table-scroll">{table}</ScrollFade>
            {/* Out of the tab order: Tab and Enter already grow the table from the keyboard. */}
            <button type="button" tabIndex={-1} className="cm-manor-table-add cm-manor-table-add-column" aria-label="Add column" title="Add column"
              onMouseDown={(event) => event.preventDefault()} onClick={() => apply(appendColumn(source))}>
              <Icon icon={PlusSignIcon} size={12} />
            </button>
            <button type="button" tabIndex={-1} className="cm-manor-table-add cm-manor-table-add-row" aria-label="Add row" title="Add row"
              onMouseDown={(event) => event.preventDefault()} onClick={() => apply(appendRow(source))}>
              <Icon icon={PlusSignIcon} size={12} />
            </button>
          </div>
        )}
        {menu === null || !structural ? null : (
          <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
            items={tableMenuItems(shape, menu.at, { edit: apply, deleteTable: onDeleteTable, source })} />
        )}
      </ControlsContext.Provider>
    </TableContext.Provider>
  )
}

class TableWidget extends WidgetType {
  constructor(private readonly source: string, private readonly readOnly: boolean) {
    super()
  }

  eq(other: TableWidget) {
    return this.source === other.source && this.readOnly === other.readOnly
  }

  toDOM(view: EditorView) {
    const wrap = view.dom.ownerDocument.createElement('div')
    wrap.className = 'cm-manor-table'
    const root = createRoot(wrap)
    roots.set(wrap, root)
    this.updateDOM(wrap, view)
    return wrap
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    const root = roots.get(dom)
    if (root === undefined) return false
    const at = () => view.posAtDOM(dom)
    root.render(<TablePreview
      source={this.source}
      onLayout={() => view.requestMeasure()}
      {...(this.readOnly ? {} : {
        onChange: (change: TableChange) => {
          if (view.state.readOnly) return
          const from = at()
          view.dispatch({
            changes: { ...change, from: from + change.from, to: from + change.to },
            annotations: Transaction.userEvent.of('input'),
          })
        },
        onUndo: (backwards: boolean) => { (backwards ? redo : undo)(view) },
        onReplace: (change: TableChange) => {
          if (view.state.readOnly) return
          const from = at()
          view.dispatch({
            changes: { ...change, from: from + change.from, to: from + change.to },
            annotations: [Transaction.userEvent.of('input.table'), ownStep],
          })
        },
        onDeleteTable: () => {
          if (view.state.readOnly) return
          const from = at()
          const range = tableDeletion(view.state.doc.toString(), from, from + this.source.length)
          view.dispatch({
            changes: { ...range, insert: '' },
            selection: { anchor: range.from },
            scrollIntoView: true,
            annotations: [Transaction.userEvent.of('delete.table'), ownStep],
          })
          view.focus()
        },
        onLeave: () => {
          const { doc } = view.state
          const end = doc.lineAt(at() + this.source.length)
          view.dispatch({ selection: { anchor: end.number < doc.lines ? doc.line(end.number + 1).from : end.to }, scrollIntoView: true })
          view.focus()
        },
      })}
    />)
    return true
  }

  destroy(dom: HTMLElement) {
    roots.get(dom)?.unmount()
    roots.delete(dom)
  }
}

function tableDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return
      // Block replacements must occupy whole lines. Nested tables keep their source.
      if (node.node.parent?.name !== 'Document') return false
      ranges.push(Decoration.replace({
        widget: new TableWidget(state.sliceDoc(node.from, node.to), state.readOnly),
        block: true,
      }).range(node.from, node.to))
      return false
    },
  })
  return Decoration.set(ranges, true)
}

// Block replacements belong in state, where CodeMirror can measure their height.
export const tablePreviewField = StateField.define<DecorationSet>({
  create: tableDecorations,
  update: (value, transaction) =>
    transaction.docChanged || transaction.reconfigured
      || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      ? tableDecorations(transaction.state) : value,
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
})

// The table starts on the text's left edge and grows with its content up to the
// reading measure, then scrolls inside it. The room around it comes from the live
// preview's block gap, like every other block.
export const tablePreviewTheme = EditorView.theme({
  '.cm-manor-table': { maxWidth: '46rem', marginLeft: 'auto', marginRight: 'auto', minWidth: '0', contain: 'inline-size', cursor: 'text' },
  // The add strips have their room whether they show or not, so hovering never moves
  // the note. They sit outside the scroller: a wide table in the narrow dock scrolls,
  // and both strips stay at the visible edge.
  '.cm-manor-table-frame': {
    display: 'grid', gridTemplateColumns: 'minmax(0, max-content) 16px', gridTemplateRows: 'auto 16px',
    gap: '2px', width: 'fit-content', maxWidth: '100%',
  },
  '.cm-manor-table-scroll': { minWidth: '0' },
  '.cm-manor-table-add': {
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0', border: '0',
    borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--color-muted)', cursor: 'pointer',
    opacity: '0', transition: 'opacity 120ms ease-out, background-color 120ms ease-out',
  },
  '.cm-manor-table-frame:hover .cm-manor-table-add, .cm-manor-table-frame:focus-within .cm-manor-table-add': { opacity: '1' },
  '.cm-manor-table-add:hover': { background: 'var(--color-surface-2)', color: 'var(--color-text)' },
  '.cm-manor-table-add-column': { gridColumn: '2', gridRow: '1' },
  '.cm-manor-table-add-row': { gridColumn: '1', gridRow: '2' },
  '@media (prefers-reduced-motion: reduce)': { '.cm-manor-table-add': { transition: 'none' } },
  '.cm-manor-table table': { width: 'max-content', maxWidth: '100%', margin: '0', borderCollapse: 'collapse', fontSize: '14px', lineHeight: '1.5' },
  '.cm-manor-table th, .cm-manor-table td': {
    padding: '6px 10px',
    border: '1px solid var(--color-line)',
    // The note's editor breaks long words anywhere; a cell must not inherit that.
    overflowWrap: 'normal',
    wordBreak: 'normal',
    verticalAlign: 'top',
    textAlign: 'left',
  },
  // Where you are is a fill, like a selected row, and the caret: no box around the text.
  '.cm-manor-table th:focus-within, .cm-manor-table td:focus-within': { background: 'var(--color-user-bg)' },
  '.cm-manor-table th': { color: 'var(--color-text)', fontWeight: 'var(--font-weight-medium)' },
  // Words wrap whole: a column too narrow for its longest word makes the table scroll
  // sideways instead of splitting the word. Only a long address may break anywhere.
  '.cm-manor-table th > div, .cm-manor-table td > div': { maxWidth: '46ch', whiteSpace: 'normal', overflowWrap: 'normal', wordBreak: 'normal' },
  // An empty cell keeps the height of a line of text. Its focus is the cell's fill.
  '.cm-manor-cell': { position: 'relative', minWidth: '2ch', minHeight: '1.5em' },
  '.cm-manor-cell:focus-visible': { outline: 'none' },
  // Wraps like the field over it: kept spaces, whole words, the cell's measure.
  '.cm-manor-cell-sizer': { display: 'block', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'normal', wordBreak: 'normal' },
  '.cm-manor-cell textarea': {
    position: 'absolute', inset: '0', display: 'block', width: '100%', height: '100%', minWidth: '0', resize: 'none', overflow: 'hidden',
    padding: '0', border: '0', outline: 'none', background: 'transparent', color: 'inherit',
    font: 'inherit', lineHeight: 'inherit', whiteSpace: 'pre-wrap', overflowWrap: 'normal', wordBreak: 'normal',
  },
  '.cm-manor-table a': { color: 'var(--accent-fg)', textDecoration: 'underline', cursor: 'pointer', overflowWrap: 'anywhere' },
  '.cm-manor-table strong': { fontWeight: 'var(--font-weight-medium)' },
  '.cm-manor-table code': { fontFamily: 'var(--font-mono)', fontSize: '0.92em' },
})
