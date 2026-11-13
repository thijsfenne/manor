import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { c, cpp, csharp, dart, java, kotlin } from '@codemirror/legacy-modes/mode/clike'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { go } from '@codemirror/legacy-modes/mode/go'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

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

const sourceHighlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--color-syntax-comment)' },
  { tag: [tags.keyword, tags.modifier, tags.self], color: 'var(--color-syntax-keyword)' },
  { tag: [tags.string, tags.character, tags.attributeValue], color: 'var(--color-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--color-syntax-number)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--color-syntax-type)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)],
    color: 'var(--color-syntax-function)',
  },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--color-syntax-property)' },
  { tag: [tags.operator, tags.punctuation, tags.meta], color: 'var(--color-syntax-operator)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--color-syntax-string)' },
])

export type SourceLanguage =
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'css'
  | 'dart'
  | 'dockerfile'
  | 'go'
  | 'html'
  | 'java'
  | 'javascript'
  | 'json'
  | 'jsx'
  | 'kotlin'
  | 'powershell'
  | 'python'
  | 'ruby'
  | 'rust'
  | 'shell'
  | 'sql'
  | 'swift'
  | 'toml'
  | 'tsx'
  | 'typescript'
  | 'yaml'

/** The languages a project is most likely to put in its file panel. */
export function sourceLanguage(path: string): SourceLanguage | null {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zprofile'].includes(name)) return 'shell'

  const suffix = name.split('.').at(-1)
  switch (suffix) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'jsx':
      return 'jsx'
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'tsx':
      return 'tsx'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'html':
    case 'htm':
      return 'html'
    case 'py':
    case 'pyi':
      return 'python'
    case 'sql':
      return 'sql'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'toml':
      return 'toml'
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell'
    case 'ps1':
    case 'psm1':
      return 'powershell'
    case 'c':
      return 'c'
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'h':
    case 'hh':
    case 'hpp':
      return 'cpp'
    case 'cs':
      return 'csharp'
    case 'java':
      return 'java'
    case 'kt':
    case 'kts':
      return 'kotlin'
    case 'dart':
      return 'dart'
    case 'go':
      return 'go'
    case 'rs':
      return 'rust'
    case 'rb':
      return 'ruby'
    case 'swift':
      return 'swift'
    default:
      return null
  }
}

const languageExtensions: Record<SourceLanguage, Extension> = {
  javascript: javascript(),
  jsx: javascript({ jsx: true }),
  typescript: javascript({ typescript: true }),
  tsx: javascript({ jsx: true, typescript: true }),
  json: json(),
  css: css(),
  html: html(),
  python: python(),
  sql: sql(),
  yaml: yaml(),
  toml: StreamLanguage.define(toml),
  shell: StreamLanguage.define(shell),
  powershell: StreamLanguage.define(powerShell),
  dockerfile: StreamLanguage.define(dockerFile),
  c: StreamLanguage.define(c),
  cpp: StreamLanguage.define(cpp),
  csharp: StreamLanguage.define(csharp),
  java: StreamLanguage.define(java),
  kotlin: StreamLanguage.define(kotlin),
  dart: StreamLanguage.define(dart),
  go: StreamLanguage.define(go),
  rust: StreamLanguage.define(rust),
  ruby: StreamLanguage.define(ruby),
  swift: StreamLanguage.define(swift),
}

export function sourceTextExtensions(
  path: string,
  { wrap = true, lineNumbers: showLineNumbers = true }: { wrap?: boolean; lineNumbers?: boolean } = {},
): Extension[] {
  const language = sourceLanguage(path)
  return [
    plainTheme,
    syntaxHighlighting(sourceHighlight),
    ...(showLineNumbers ? [lineNumbers()] : []),
    ...(language === null ? [] : [languageExtensions[language]]),
    ...(wrap ? [EditorView.lineWrapping] : []),
  ]
}
