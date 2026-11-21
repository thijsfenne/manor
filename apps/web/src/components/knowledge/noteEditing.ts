import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'
import { EditorState, Facet, Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type Command, type DecorationSet, type KeyBinding, type ViewUpdate } from '@codemirror/view'
import { exitEmptyQuote, indentList, moveLines, renumberFollowUp, todoTrigger, turnInto, unwrapBlockBackward } from './blockCommands'
import { linkAt, toggleMark, wikilinkAt } from './formatCommands'
import { asCommand, codeBlockAt, inFrontmatter, type NoteTransform } from './noteSyntax'
import { applyHighlighted, closeSlashMenu, moveSlashIndex, openSlashMenu, slashEffect, slashField } from './slashMenu'

/**
 * The editing behaviour of a note, as one extension list: Notion's shortcuts and
 * typing rules on top of lang-markdown, the slash menu's state and keys, and the
 * "Press '/' for commands" hint. The floating toolbar and the menu's rows are React,
 * in `NoteFormatting.tsx`; they reach in through `noteUi`.
 */

/** What the React layer offers the keymap: the link field and keyboard entry into the toolbar. */
export interface NoteUi {
  openLink: (view: EditorView) => boolean
  focusToolbar: (view: EditorView) => boolean
}

export const noteUi = Facet.define<NoteUi, NoteUi | null>({ combine: (values) => values[0] ?? null })

/** A shortcut the note always answers, even where it changes nothing (code, frontmatter). */
const always = (transform: NoteTransform): Command => (view) => {
  const spec = transform(view.state)
  if (spec !== null) view.dispatch(view.state.update(spec))
  return true
}

/** A caret in a link's text: ⌘K there edits that link instead of opening search. */
const caretInLink = (state: EditorState) => {
  const head = state.selection.main.head
  return wikilinkAt(state, head) !== null || linkAt(state, head) !== null
}

// The app binds ⌘B (right panel) on the window. Inside a note it formats instead, so
// the key stops here rather than runs twice. ⌘D (sidebar list) is not bound here at
// all, and ⌘K (search) only over a selection or in a link, where it edits the link.
const own = (key: string, run: Command): KeyBinding => ({ key, run, preventDefault: true, stopPropagation: true })

const formatKeys: KeyBinding[] = [
  own('Mod-b', always(toggleMark('bold'))),
  own('Mod-i', always(toggleMark('italic'))),
  own('Mod-Shift-s', always(toggleMark('strike'))),
  own('Mod-e', always(toggleMark('code'))),
  // Not `own`: a binding with `preventDefault` is prevented even when its command
  // declines. Without it, an empty selection returns false, CodeMirror neither prevents
  // nor stops the key, and the window's search shortcut fires as it does everywhere
  // else; over a selection the command handles it and `stopPropagation` keeps search shut.
  { key: 'Mod-k', run: (view) => (view.state.selection.main.empty && !caretInLink(view.state) ? false : view.state.facet(noteUi)?.openLink(view) ?? false), stopPropagation: true },
  own('Mod-Alt-0', always(turnInto('text'))),
  own('Mod-Alt-1', always(turnInto('h1'))),
  own('Mod-Alt-2', always(turnInto('h2'))),
  own('Mod-Alt-3', always(turnInto('h3'))),
  own('Mod-Alt-4', always(turnInto('todo'))),
  own('Mod-Alt-5', always(turnInto('bullet'))),
  own('Mod-Alt-6', always(turnInto('number'))),
  own('Mod-Alt-8', always(turnInto('code'))),
  // CodeMirror's own line move, with the renumbering a numbered list needs. Mod-Shift
  // Arrow stays macOS's "select to the start or end of the note".
  own('Alt-ArrowUp', always(moveLines('up'))),
  own('Alt-ArrowDown', always(moveLines('down'))),
  { key: 'Alt-F10', run: (view) => view.state.facet(noteUi)?.focusToolbar(view) ?? false, preventDefault: true },
]

/**
 * lang-markdown's own keymap, replaced so Enter on an empty item always leaves the
 * list (`nonTightLists: false`) and Backspace and Tab learn the block rules first.
 */
const blockKeys: KeyBinding[] = [
  { key: 'Enter', run: asCommand(exitEmptyQuote) },
  { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
  { key: 'Backspace', run: asCommand(unwrapBlockBackward) },
  { key: 'Backspace', run: deleteMarkupBackward },
  { key: 'Tab', run: asCommand(indentList(1)), shift: asCommand(indentList(-1)) },
]

const slashKeys: KeyBinding[] = [
  { key: 'ArrowDown', run: asCommand((state) => moveSlashIndex(state, 1)) },
  { key: 'ArrowUp', run: asCommand((state) => moveSlashIndex(state, -1)) },
  { key: 'Enter', run: asCommand(applyHighlighted) },
  { key: 'Tab', run: asCommand(applyHighlighted) },
  { key: 'Escape', run: asCommand(closeSlashMenu), stopPropagation: true },
]

/** Typed `[]` or `[ ]` then space becomes a to-do. Never during composition. */
const typingRules = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing) return false
  const spec = todoTrigger(view.state, from, to, text)
  if (spec === null) return false
  view.dispatch(view.state.update(spec))
  return true
})

/** A deletion inside a numbered list renumbers that list in the same transaction. */
const renumberOnDelete = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('delete')) return tr
  const more = renumberFollowUp(tr)
  return more === null ? tr : [tr, more]
})

/** The open menu, announced on the text itself: a combobox whose rows live in a portal. */
const slashAria = EditorView.contentAttributes.compute(['doc', 'selection', slashField], (state): Record<string, string> => {
  const menu = openSlashMenu(state)
  const active = menu?.items[menu.index]
  if (menu === null || active === undefined) return {}
  return { 'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': 'manor-slash-menu', 'aria-activedescendant': `manor-slash-${active.id}` }
})

/** Losing focus closes the menu, so it is never found open over another panel later. */
const closeOnBlur = EditorView.focusChangeEffect.of((state, focusing) =>
  focusing || openSlashMenu(state) === null ? null : slashEffect.of({ type: 'close' }),
)

// ---------------------------------------------------------------------------
// The link being edited keeps its highlight while the toolbar's field has focus.

export const linkDraftEffect = StateEffect.define<{ from: number; to: number } | null>()

const draftMark = Decoration.mark({ class: 'cm-manor-link-draft' })

export const linkDraftField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(linkDraftEffect)) continue
      next = effect.value === null || effect.value.from === effect.value.to
        ? Decoration.none
        : Decoration.set([draftMark.range(effect.value.from, effect.value.to)])
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

// ---------------------------------------------------------------------------
// "Press '/' for commands" on the empty line the caret is on.

class HintWidget extends WidgetType {
  eq() {
    return true
  }

  toDOM() {
    const hint = window.document.createElement('span')
    hint.className = 'cm-manor-slash-hint'
    hint.textContent = "Press '/' for commands"
    hint.setAttribute('aria-hidden', 'true')
    return hint
  }

  ignoreEvent() {
    return true
  }
}

const hint = Decoration.widget({ widget: new HintWidget(), side: 1 })

/** Where the hint belongs: the caret's empty line, in prose, in a note that has text. */
export function hintLine(state: EditorState, focused: boolean): number | null {
  const range = state.selection.main
  if (!focused || state.selection.ranges.length !== 1 || !range.empty || state.doc.length === 0) return null
  const line = state.doc.lineAt(range.head)
  if (line.length !== 0 || inFrontmatter(state, line.from) || codeBlockAt(state, line) !== null) return null
  return line.from
}

const hintPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged) this.decorations = this.build(update.view)
    }

    build(view: EditorView): DecorationSet {
      const at = hintLine(view.state, view.hasFocus)
      return at === null ? Decoration.none : Decoration.set([hint.range(at)])
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

const editingTheme = EditorView.theme({
  '.cm-manor-slash-hint': { color: 'var(--color-dim)', pointerEvents: 'none', userSelect: 'none' },
  '.cm-manor-link-draft': { backgroundColor: 'var(--color-user-bg)', borderRadius: 'var(--radius-xs)' },
})

/** Everything above, in precedence order. The note editor adds `noteUi` for the toolbar. */
export const noteEditingExtensions = (): Extension[] => [
  slashField,
  linkDraftField,
  Prec.highest(keymap.of(slashKeys)),
  Prec.high(keymap.of([...formatKeys, ...blockKeys])),
  typingRules,
  renumberOnDelete,
  closeOnBlur,
  slashAria,
  hintPlugin,
  editingTheme,
]
