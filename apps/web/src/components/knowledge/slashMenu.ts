import { EditorSelection, StateEffect, StateField, type EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { insertBlock, type InsertKind } from './blockCommands'
import { chain, enclosing, inFrontmatter, linePrefix } from './noteSyntax'

/**
 * The note editor's "/" menu. Typing "/" at the start of a line or after a space
 * opens it; what follows filters it; picking an item removes the "/query" text and
 * turns the line into that block. The open state lives in the editor state, so the
 * keys and the tests read it without the React layer.
 */
export interface SlashItem {
  id: InsertKind
  name: string
  description: string
  /** The markdown it writes, or the shortcut where there is no markdown to show. */
  hint: string
  keywords: readonly string[]
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: 'text', name: 'Text', description: 'Plain writing, no block', hint: '⌘⌥0', keywords: ['paragraph', 'plain', 'body'] },
  { id: 'h1', name: 'Heading 1', description: 'Big section heading', hint: '#', keywords: ['h1', 'title', 'heading'] },
  { id: 'h2', name: 'Heading 2', description: 'Medium section heading', hint: '##', keywords: ['h2', 'subtitle', 'heading'] },
  { id: 'h3', name: 'Heading 3', description: 'Small section heading', hint: '###', keywords: ['h3', 'heading'] },
  { id: 'bullet', name: 'Bulleted list', description: 'A simple bulleted list', hint: '-', keywords: ['ul', 'unordered', 'bullet', 'list'] },
  { id: 'number', name: 'Numbered list', description: 'A list with numbers', hint: '1.', keywords: ['ol', 'ordered', 'number', 'list'] },
  { id: 'todo', name: 'To-do list', description: 'Track tasks with a checkbox', hint: '[]', keywords: ['todo', 'task', 'checkbox', 'check'] },
  { id: 'quote', name: 'Quote', description: 'Capture a quote', hint: '>', keywords: ['blockquote', 'citation'] },
  { id: 'divider', name: 'Divider', description: 'Separate sections with a line', hint: '---', keywords: ['hr', 'rule', 'line', 'separator'] },
  { id: 'code', name: 'Code block', description: 'Capture a code snippet', hint: '```', keywords: ['code', 'snippet', 'fence', 'pre'] },
  { id: 'callout', name: 'Callout', description: 'Make a passage stand out', hint: '> [!note]', keywords: ['note', 'info', 'tip', 'warning', 'admonition'] },
  { id: 'table', name: 'Table', description: 'A small two column table', hint: '| |', keywords: ['grid', 'columns', 'rows'] },
]

/** The items for `query`, best match first: name start, then a word in the name, then a keyword. */
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...SLASH_ITEMS]
  const scored: { item: SlashItem; score: number }[] = []
  for (const item of SLASH_ITEMS) {
    const name = item.name.toLowerCase()
    const score = name.startsWith(q)
      ? 0
      : name.split(/[\s-]+/).some((word) => word.startsWith(q)) || name.includes(q)
        ? 1
        : item.keywords.some((keyword) => keyword.startsWith(q))
          ? 2
          : -1
    if (score >= 0) scored.push({ item, score })
  }
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.item)
}

export interface SlashState {
  /** Where the "/" is. */
  from: number
  /** The highlighted row in the filtered list. */
  index: number
}

export const slashEffect = StateEffect.define<{ type: 'close' } | { type: 'move'; index: number }>()

/** Nodes in which "/" is a character, not a command: code, link targets, raw HTML, tables. */
const LITERAL: ReadonlySet<string> = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'URL', 'Autolink', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'Table', 'LinkReference'])

/** Whether a "/" at `at` may open the menu, by position alone. */
export function slashAllowedAt(state: EditorState, at: number): boolean {
  if (state.doc.sliceString(at, at + 1) !== '/') return false
  const line = state.doc.lineAt(at)
  if (at > line.from && !/\s/.test(state.doc.sliceString(at - 1, at))) return false
  if (inFrontmatter(state, at)) return false
  return enclosing(state, at, LITERAL) === null
}

/** The text typed after the "/", or null when the menu should not be open for it. */
export function slashQuery(state: EditorState, from: number): string | null {
  const range = state.selection.main
  if (state.selection.ranges.length !== 1 || !range.empty) return null
  if (state.doc.sliceString(from, from + 1) !== '/') return null
  const head = range.head
  if (head <= from || state.doc.lineAt(head).number !== state.doc.lineAt(from).number) return null
  const query = state.doc.sliceString(from + 1, head)
  if (query.length > 32 || /^\s/.test(query) || /\s\s/.test(query)) return null
  return query
}

/**
 * A typed "/" (not composed, not pasted) that may open the menu: its position.
 *
 * Typed text can arrive as several characters in one change: CodeMirror reads the
 * DOM after the browser has applied the keys, and a fast burst ("/divi") lands as one
 * insertion. The "/" then sits inside the inserted text with the query after it.
 */
function openedAt(tr: Transaction): number | null {
  if (!tr.isUserEvent('input.type') || tr.isUserEvent('input.type.compose') || !tr.docChanged) return null
  let at: number | null = null
  let end = -1
  let count = 0
  tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    count += 1
    const text = inserted.toString()
    const slash = text.lastIndexOf('/')
    if (slash === -1 || text.slice(slash).includes('\n')) return
    at = fromB + slash
    end = toB
  })
  if (count !== 1 || at === null) return null
  const state = tr.state
  if (state.selection.ranges.length !== 1 || state.selection.main.head !== end) return null
  return slashAllowedAt(state, at) ? at : null
}

export const slashField = StateField.define<SlashState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(slashEffect)) continue
      if (effect.value.type === 'close') return null
      if (value !== null) value = { ...value, index: effect.value.index }
    }
    const opened = openedAt(tr)
    if (opened !== null && (value === null || tr.changes.mapPos(value.from) !== opened)) return { from: opened, index: 0 }
    if (value === null) return null
    if (!tr.docChanged && !tr.selection) return value
    const from = tr.changes.mapPos(value.from, 1)
    if (slashQuery(tr.state, from) === null) return null
    return { from, index: tr.docChanged ? 0 : value.index }
  },
})

/** The open menu with its rows, or null when nothing is showing. */
export function openSlashMenu(state: EditorState): { from: number; query: string; items: SlashItem[]; index: number } | null {
  const open = state.field(slashField, false)
  if (open === undefined || open === null) return null
  const query = slashQuery(state, open.from)
  if (query === null) return null
  const items = filterSlashItems(query)
  if (items.length === 0) return null
  return { from: open.from, query, items, index: Math.min(open.index, items.length - 1) }
}

/** Remove the "/query" text and put the block in its place. One undo step. */
export function applySlashItem(state: EditorState, item: SlashItem): TransactionSpec | null {
  const open = state.field(slashField, false)
  if (open === undefined || open === null) return null
  const head = state.selection.main.head
  // The space typed to open the menu after a word goes with the query.
  const line = state.doc.lineAt(open.from)
  const before = state.doc.sliceString(line.from, open.from)
  const afterText = open.from - line.from > linePrefix(line.text).end
  const from = afterText && /\S\s$/.test(before) ? open.from - 1 : open.from
  return chain(
    state,
    {
      changes: { from, to: head },
      selection: EditorSelection.cursor(from),
      effects: slashEffect.of({ type: 'close' }),
      userEvent: 'input.format',
    },
    (after) => insertBlock(item.id)(after),
  )
}

/** Escape: close the menu and leave what was typed. */
export function closeSlashMenu(state: EditorState): TransactionSpec | null {
  const open = state.field(slashField, false)
  if (open === undefined || open === null) return null
  return { effects: slashEffect.of({ type: 'close' }) }
}

/** Arrow keys: the highlighted row, wrapping at either end. */
export function moveSlashIndex(state: EditorState, step: 1 | -1): TransactionSpec | null {
  const menu = openSlashMenu(state)
  if (menu === null) return null
  const index = (menu.index + step + menu.items.length) % menu.items.length
  return { effects: slashEffect.of({ type: 'move', index }) }
}

/** Enter or Tab: apply the highlighted row. */
export function applyHighlighted(state: EditorState): TransactionSpec | null {
  const menu = openSlashMenu(state)
  if (menu === null) return null
  const item = menu.items[menu.index]
  return item === undefined ? null : applySlashItem(state, item)
}

