import { bodyOffset } from '../../vaultNotes'
import { useOpenWebsite } from '../ExternalLink'
import { TextEditor } from '../ui/TextEditor'
import { linkDestination } from './formatCommands'
import { livePreviewExtensions } from './livePreview'
import { NoteFormatting, type NoteFormattingHandle, type QuoteAction } from './NoteFormatting'
import { noteAiApply, noteAiExtensions } from './noteAi'
import { NoteAiLayer } from './NoteAiUi'
import { noteUi } from './noteEditing'
import type { NoteAi } from './useNoteAi'
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, placeholder, type ViewUpdate } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'

interface NoteEditorProps {
  /** The note's own path. A different note is a different document, not new text. */
  path: string
  /** Stays the same across a rename or a move, so the editor is not rebuilt for one. */
  document?: number
  text: string
  onChange: (value: string) => void
  onFollowNote: (target: string) => void
  /** Sending the selection to a chat, shown as the toolbar's last controls. */
  quote?: readonly QuoteAction[]
  /** AI edits of this note: the comment field under a selection and the proposal on the text. */
  ai?: NoteAi
}

const NO_QUOTE: readonly QuoteAction[] = []

const editLabel = (path: string) =>
  EditorView.contentAttributes.of({ 'aria-label': `Edit note ${path.split('/').pop()?.replace(/\.md$/i, '') ?? path}` })

/**
 * A note in the shared editor, wearing Obsidian's live preview and Notion's way of
 * formatting: a toolbar over a selection, a "/" menu, the shortcuts. The file on disk
 * is still plain markdown; only the rendering of it and the ways to write it changed.
 * The caret opens past the frontmatter, because nobody starts a note by editing its YAML.
 */
export function NoteEditor({ path, document, text, onChange, onFollowNote, quote = NO_QUOTE, ai }: NoteEditorProps) {
  const followNote = useRef(onFollowNote)
  followNote.current = onFollowNote
  const openWebsite = useOpenWebsite()
  const [view, setView] = useState<EditorView | null>(null)
  const [version, setVersion] = useState(0)
  const handle = useRef<NoteFormattingHandle | null>(null)
  const aiRef = useRef(ai)
  aiRef.current = ai
  // A rename or a move keeps the document, so the label is swapped in place to name the note it now is.
  const label = useRef(new Compartment())
  useEffect(() => {
    view?.dispatch({ effects: label.current.reconfigure(editLabel(path)) })
  }, [view, path])

  // Built once: the editor reads its extensions when a document opens, and these
  // reach React through refs and setters that never change identity.
  const bridge = useRef<Extension[] | null>(null)
  if (bridge.current === null) {
    bridge.current = [
      ViewPlugin.define((editor) => {
        setView(editor)
        return {
          update: (update: ViewUpdate) => {
            // Text that changed under a job or a proposal (Reload theirs, a format command)
            // leaves its offsets pointing at other words, so it ends there.
            const now = aiRef.current
            if (update.docChanged && now !== undefined && now.state.phase !== 'idle' && update.transactions.some((tr) => tr.docChanged && tr.annotation(noteAiApply) !== true)) {
              now.invalidate()
            }
            if (update.docChanged || update.selectionSet || update.focusChanged || update.geometryChanged || update.transactions.some((tr) => tr.effects.length > 0)) {
              setVersion((value) => value + 1)
            }
          },
          destroy: () => setView((current) => (current === editor ? null : current)),
        }
      }),
      noteUi.of({
        openLink: (editor) => handle.current?.openLink(editor) ?? false,
        focusToolbar: (editor) => handle.current?.focusToolbar(editor) ?? false,
      }),
    ]
  }

  const follow = (event: { target: EventTarget | null; preventDefault: () => void; stopPropagation: () => void }) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-note-target]') : null
    if (!target?.dataset.noteTarget) return false
    event.preventDefault()
    event.stopPropagation()
    followNote.current(target.dataset.noteTarget)
    return true
  }

  /**
   * A markdown link: a plain click opens it when its line is not being edited (the
   * live preview only marks those `data-href`), Mod-click always. Websites go through
   * the app's link policy; anything else is read as a note in this vault.
   */
  const openLink = (event: React.MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-href],[data-href-edit]') : null
    if (target === null) return false
    const href = target.dataset.href ?? (event.metaKey || event.ctrlKey ? target.dataset.hrefEdit : undefined)
    if (href === undefined || href === '') return false
    event.preventDefault()
    event.stopPropagation()
    const destination = linkDestination(href)
    if (destination.kind === 'website') {
      if (openWebsite?.(destination.url) !== true) window.open(destination.url, '_blank', 'noopener,noreferrer')
    } else if (destination.kind === 'mail') {
      // The desktop shell hands mailto to the mail app; a browser does the same itself.
      window.open(destination.url, '_blank', 'noopener,noreferrer')
    } else if (destination.kind === 'note') {
      followNote.current(safeDecode(destination.target).replace(/\.md$/i, ''))
    }
    return true
  }

  return (
    <div
      onMouseDownCapture={(event) => {
        if (event.button !== 0 || event.altKey) return
        if (!follow(event)) openLink(event)
      }}
      onKeyDownCapture={(event) => { if (event.key === 'Enter') follow(event) }}
    >
      <TextEditor
        path={path}
        {...(document === undefined ? {} : { documentKey: String(document) })}
        text={text}
        extensions={[
          ...livePreviewExtensions(),
          ...bridge.current,
          ...noteAiExtensions(),
          placeholder("Start writing, or press '/' for blocks. Changes save automatically."),
          label.current.of(editLabel(path)),
        ]}
        cursor={bodyOffset(text)}
        className="cm-manor"
        onChange={onChange}
      />
      <NoteFormatting view={view} version={version} quote={quote} handle={handle} />
      {ai === undefined ? null : <NoteAiLayer view={view} version={version} ai={ai} />}
    </div>
  )
}

function safeDecode(href: string): string {
  try {
    return decodeURI(href)
  } catch {
    return href
  }
}
