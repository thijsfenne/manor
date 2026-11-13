import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { sourceLanguage } from '@manor/client-runtime/languages'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { languageSupport, sourceHighlighter } from './sourceSyntax'

interface TextEditorProps {
  /** The file's own path. A different file is a different document, not new text. */
  path: string
  /** Names the document instead of `path` when one file can change its path, as a moved note does. */
  documentKey?: string
  text: string
  /**
   * What this kind of file turns on: the vault's live preview, or the plain set
   * below. Read once, when the document is built, so a caller that rebuilds the
   * list every render does not tear the editor down with it.
   */
  extensions: Extension[]
  /** Where the caret lands when the document opens. */
  cursor?: number
  className?: string
  /** Omitted for a selectable, read-only preview. */
  onChange?: (value: string) => void
  /** The current selected slice, empty when the caret is collapsed. `clear` collapses the CodeMirror range. */
  onSelect?: (text: string, rect: { left: number; top: number } | null, clear: () => void) => void
}

/**
 * Whether a text field outside the editor already holds the caret, such as the name
 * field Rename opens together with the note: a new document then leaves it there.
 */
export function typingElsewhere(document: Document): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && (active.matches('input, textarea, select') || active.isContentEditable)
}

/**
 * The editing surface, shared by the vault and the repo files panel. CodeMirror
 * rather than a textarea, because the user asked for Obsidian's reading experience
 * while editing a note and a textarea can only ever show one font at one size.
 * What differs per surface is the extension list, which is why that is a prop.
 */
export function TextEditor({ path, documentKey, text, extensions, cursor = 0, className, onChange, onSelect }: TextEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // Held in refs so the document never has to be rebuilt to see a newer callback or
  // a fresh extension array; rebuilding drops undo history and the cursor with it.
  const emit = useRef(onChange)
  emit.current = onChange
  const emitSelect = useRef<(text: string, rect: { left: number; top: number } | null, clear: () => void) => void>()
  emitSelect.current = onSelect
  const clearSelection = useRef(() => {
    const editor = view.current
    if (editor === null) return
    const pos = editor.state.selection.main.head
    editor.dispatch({ selection: { anchor: pos } })
  })
  const build = useRef({ text, extensions, cursor, onChange })
  build.current = { text, extensions, cursor, onChange }

  const identity = documentKey ?? path
  // Keyed on the path, not the text: a different file gets a fresh document with its
  // own undo history, while typing into the open one must not tear the editor down.
  useEffect(() => {
    if (host.current === null) return
    const opening = build.current
    const editable = opening.onChange !== undefined
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: opening.text,
        selection: { anchor: Math.min(opening.cursor, opening.text.length) },
        extensions: [
          ...(editable
            ? [
                history(),
                // The app's own ⌘S and ⌘E stay with the panel around this, so this is only
                // the editing set: it deliberately does not bind them.
                keymap.of([...defaultKeymap, ...historyKeymap]),
              ]
            : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          ...opening.extensions,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) emit.current?.(update.state.doc.toString())
            if (update.selectionSet || update.docChanged) {
              const sel = update.state.selection.main
              const from = sel.empty ? null : update.view.coordsAtPos(sel.from)
              emitSelect.current?.(
                sel.empty ? '' : update.state.sliceDoc(sel.from, sel.to),
                from === null ? null : { left: from.left, top: from.top },
                clearSelection.current,
              )
            }
          }),
        ],
      }),
    })
    view.current = editor
    if (editable && !typingElsewhere(host.current.ownerDocument)) editor.focus()
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [identity])

  // Text that changed from outside the editor: "Reload theirs" on a conflict is the
  // only one that does. Guarded, or every keystroke would round-trip through here and
  // reset the cursor to where the state happened to say it was.
  useEffect(() => {
    const editor = view.current
    if (editor === null || editor.state.doc.toString() === text) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
  }, [text])

  return <div ref={host} className={className} />
}

/**
 * Source geometry stays the same for every language. The grammar and token colours
 * change, but code never turns into a different editor when its suffix changes.
 *
 * Wrapped rather than scrolled sideways, which is the opposite of what an IDE does
 * and right here: this editor lives in a panel that is 320px wide at its narrowest,
 * where a horizontal scrollbar would hide the end of every second line.
 */
const plainTheme = EditorView.theme({
  '&': { color: 'var(--color-text)', backgroundColor: 'transparent', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
    padding: '0',
    caretColor: 'var(--color-text)',
  },
  '.cm-line': { padding: '0' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: '0',
    color: 'var(--color-dim)',
  },
  '.cm-lineNumbers': { fontFamily: 'var(--font-mono)' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '3ch', padding: '0 12px 0 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-user-bg)',
  },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
})

/** `firstLine` lets an extensionless script colour by its `#!`. */
export function sourceTextExtensions(
  path: string,
  { wrap = true, lineNumbers: showLineNumbers = true, firstLine }: { wrap?: boolean; lineNumbers?: boolean; firstLine?: string } = {},
): Extension[] {
  const language = sourceLanguage(path, firstLine)
  return [
    plainTheme,
    syntaxHighlighting(sourceHighlighter),
    ...(showLineNumbers ? [lineNumbers()] : []),
    ...(language === null ? [] : [languageSupport(language)]),
    ...(wrap ? [EditorView.lineWrapping] : []),
  ]
}
