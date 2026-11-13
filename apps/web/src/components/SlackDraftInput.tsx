import { defaultKeymap } from '@codemirror/commands'
import { Annotation, EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { inlineText, type DraftBlock } from '@manor/client-runtime/slack-draft-formatting'

export interface DraftInputSelection { start: number; end: number }
export interface DraftInputHandle { focus: (selection?: DraftInputSelection) => void }
interface Props {
  block: DraftBlock
  label: string
  register: (handle: DraftInputHandle | null) => void
  onChange: (text: string, before: DraftInputSelection) => void
  onSelection: (selection: DraftInputSelection) => void
  onCommand: (command: 'enter' | 'softBreak' | 'backspace' | 'bold' | 'italic' | 'undo' | 'redo', selection: DraftInputSelection) => boolean
}
const fromModel = Annotation.define<boolean>()
export const replaceDraftDecorations = StateEffect.define<DecorationSet>()
export const draftDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes)
    for (const effect of transaction.effects) if (effect.is(replaceDraftDecorations)) next = effect.value
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})
const selectionOf = (state: EditorState) => ({ start: state.selection.main.from, end: state.selection.main.to })

export function draftRunDecorations(block: DraftBlock): DecorationSet {
  let offset = 0
  return Decoration.set(block.elements.flatMap((run) => {
    const from = offset
    offset += inlineText(run).length
    const classes = [run.style?.bold && 'font-semibold', run.style?.italic && 'italic', run.style?.strike && (run.type === 'link' ? '[text-decoration-line:underline_line-through]' : 'line-through'), (run.type !== 'user' && run.style?.code) && 'rounded-sm bg-surface-2 px-1 font-mono', run.type === 'link' && !run.style?.strike && 'underline', run.type === 'user' && 'rounded-sm bg-[color-mix(in_srgb,var(--color-muted)_18%,transparent)] font-medium'].filter(Boolean).join(' ')
    return from < offset && classes ? [Decoration.mark({ class: classes }).range(from, offset)] : []
  }))
}
const theme = EditorView.theme({
  '&': { fontSize: 'inherit', color: 'inherit', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { padding: '0', fontFamily: 'inherit', caretColor: 'var(--color-text)' },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'inherit', lineHeight: 'inherit' },
})

/** The same editor engine as TextEditor, with document styles instead of Markdown syntax. */
export function SlackDraftInput(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const current = useRef(props)
  current.current = props
  useEffect(() => {
    if (!host.current) return
    const command = (name: Parameters<Props['onCommand']>[0]) => (editor: EditorView) => current.current.onCommand(name, selectionOf(editor.state))
    const initial = current.current
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.block.elements.map(inlineText).join(''),
        extensions: [
          theme, EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': initial.label, role: 'textbox', 'aria-multiline': 'true' }),
          draftDecorations,
          keymap.of([
            { key: 'Enter', run: command('enter') }, { key: 'Shift-Enter', run: command('softBreak') },
            { key: 'Backspace', run: command('backspace') },
            { key: 'Mod-b', run: command('bold') }, { key: 'Mod-i', run: command('italic') },
            { key: 'Mod-z', run: command('undo') }, { key: 'Mod-Shift-z', run: command('redo') },
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.transactions.some((transaction) => transaction.annotation(fromModel))) return
            if (update.docChanged) current.current.onChange(update.state.doc.toString(), selectionOf(update.startState))
            else if (update.selectionSet || (update.focusChanged && update.view.hasFocus)) current.current.onSelection(selectionOf(update.state))
          }),
        ],
      }),
    })
    view.current = editor
    initial.register({ focus: (selection) => {
      if (selection) editor.dispatch({ selection: { anchor: Math.min(selection.start, editor.state.doc.length), head: Math.min(selection.end, editor.state.doc.length) }, annotations: fromModel.of(true), scrollIntoView: true })
      editor.focus()
    } })
    return () => { initial.register(null); view.current = null; editor.destroy() }
  }, [])
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const text = props.block.elements.map(inlineText).join('')
    editor.dispatch({
      ...(editor.state.doc.toString() === text ? {} : { changes: { from: 0, to: editor.state.doc.length, insert: text } }),
      effects: replaceDraftDecorations.of(draftRunDecorations(props.block)), annotations: fromModel.of(true),
    })
  }, [props.block])
  return <div ref={host} className="min-w-0 min-h-[1lh]" />
}
