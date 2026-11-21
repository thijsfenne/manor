import { AddSquareIcon, Image01Icon, TableIcon, TextIcon } from '@hugeicons/core-free-icons'
import { bodyOffset } from '../../vaultNotes'
import { useOpenWebsite } from '../ExternalLink'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem, useMenu } from '../ui/Menu'
import { TextEditor } from '../ui/TextEditor'
import { canInsertBlock, insertBlock, type InsertKind } from './blockCommands'
import { linkDestination } from './formatCommands'
import { livePreviewExtensions } from './livePreview'
import { NoteFormatting, SLASH_ICONS, type NoteFormattingHandle, type QuoteAction } from './NoteFormatting'
import { noteAiApply, noteAiExtensions } from './noteAi'
import { NoteAiLayer } from './NoteAiUi'
import { noteUi } from './noteEditing'
import { insertPictures, landImage, noteImageAccept, noteImageConfig, noteImageExtensions, picturePickerSpot, type NoteImageConfig } from './noteImages'
import { frontmatterRange } from './noteSyntax'
import { SLASH_ITEMS } from './slashMenu'
import type { NoteAi } from './useNoteAi'
import type { VaultImageSaveResult } from '../../state'
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, placeholder, type ViewUpdate } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface NoteEditorProps {
  toolsSlot: HTMLElement | null
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
  /** Pictures: the vault's listing and the way a paste or drop saves one. Absent shows embeds as text. */
  pictures?: NotePictures
}

export interface NotePictures {
  images: Readonly<Record<string, string>>
  attachmentFolder: string | null
  /** Answers to picture saves, by request id. */
  saves: Readonly<Record<string, VaultImageSaveResult>> | undefined
  /** Sends one picture for `notePath`; false when nothing went out. */
  onSave: ((requestId: string, notePath: string, name: string, dataUrl: string) => boolean) | null
  onForget: (requestId: string) => void
}

const NO_QUOTE: readonly QuoteAction[] = []
const NO_IMAGES: Readonly<Record<string, string>> = {}

const editLabel = (path: string) =>
  EditorView.contentAttributes.of({ 'aria-label': `Edit note ${path.split('/').pop()?.replace(/\.md$/i, '') ?? path}` })

/**
 * A note in the shared editor, wearing Obsidian's live preview and Notion's way of
 * formatting: a toolbar over a selection, a "/" menu, the shortcuts. The file on disk
 * is still plain markdown; only the rendering of it and the ways to write it changed.
 * The caret opens past the frontmatter, because nobody starts a note by editing its YAML.
 */
export function NoteEditor({ toolsSlot, path, document, text, onChange, onFollowNote, quote = NO_QUOTE, ai, pictures }: NoteEditorProps) {
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

  // The listing and the note's path feed the picture extension; a new listing redraws only what changed.
  const imageCompartment = useRef(new Compartment())
  const saveImage = useRef(pictures?.onSave ?? null)
  saveImage.current = pictures?.onSave ?? null
  // Ids this editor sent, so it drops only its own answers; another docked note may be waiting on others.
  const sentImages = useRef(new Set<string>())
  const imageConfig = (notePath: string, images: Readonly<Record<string, string>>, attachmentFolder: string | null): NoteImageConfig => ({
    notePath,
    images,
    attachmentFolder,
    save: (id, name, dataUrl) => {
      const sent = saveImage.current?.(id, notePath, name, dataUrl) ?? false
      if (sent) sentImages.current.add(id)
      return sent
    },
  })
  const images = pictures?.images ?? NO_IMAGES
  const attachmentFolder = pictures?.attachmentFolder ?? null
  const initialImages = useRef(imageConfig(path, images, attachmentFolder))
  useEffect(() => {
    view?.dispatch({ effects: imageCompartment.current.reconfigure(noteImageConfig.of(imageConfig(path, images, attachmentFolder))) })
  }, [view, path, images, attachmentFolder])

  // A save's answer lands its embed where the paste or drop asked; one whose chip was dismissed is dropped.
  const saves = pictures?.saves
  const forgetSave = pictures?.onForget
  useEffect(() => {
    if (view === null || saves === undefined || forgetSave === undefined) return
    for (const [id, result] of Object.entries(saves)) {
      if (!sentImages.current.has(id)) continue
      landImage(view, id, result)
      sentImages.current.delete(id)
      forgetSave(id)
    }
  }, [view, saves, forgetSave])

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
          ...noteImageExtensions(),
          imageCompartment.current.of(noteImageConfig.of(initialImages.current)),
          ...bridge.current,
          ...noteAiExtensions(),
          placeholder("Start writing, or press '/' for blocks. Changes save automatically."),
          label.current.of(editLabel(path)),
        ]}
        cursor={bodyOffset(text)}
        className="cm-manor"
        onChange={onChange}
      />
      {toolsSlot === null || view === null ? null : createPortal(
        <NoteTools view={view} canSaveImage={pictures?.onSave != null} />,
        toolsSlot,
      )}
      <NoteFormatting view={view} version={version} quote={quote} handle={handle} />
      {ai === undefined ? null : <NoteAiLayer view={view} version={version} ai={ai} />}
    </div>
  )
}

function NoteTools({ view, canSaveImage }: { view: EditorView; canSaveImage: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const meta = frontmatterRange(view.state)
  const protectedSelection = meta !== null && view.state.selection.main.from <= meta.to
  const disabled = protectedSelection || !canInsertBlock(view.state)
  const [menu, trigger] = useMenu({ maxHeight: 400, minHeight: 100, minWidth: 180, disabled })

  const insert = (kind: InsertKind) => {
    const spec = insertBlock(kind)(view.state)
    if (spec !== null) view.dispatch(spec)
    view.focus()
  }

  return (
    <>
      <IconButton icon={TextIcon} size={28} label="Insert text block" disabled={disabled} onClick={() => insert('text')} />
      <IconButton icon={Image01Icon} size={28} label="Insert image" disabled={!canSaveImage || picturePickerSpot(view.state) === null} onClick={() => input.current?.click()} />
      <input ref={input} type="file" hidden accept={noteImageAccept} multiple onChange={(event) => {
        insertPictures(view, event.currentTarget.files)
        event.currentTarget.value = ''
        view.focus()
      }} />
      <IconButton icon={TableIcon} size={28} label="Insert table" disabled={disabled} onClick={() => insert('table')} />
      <IconButton ref={trigger} icon={AddSquareIcon} size={28} label="Insert block" disabled={disabled}
        aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle} />
      <Menu menu={menu} label="Insert block">
        {SLASH_ITEMS.map((item) => (
          <MenuItem key={item.id} icon={SLASH_ICONS[item.id]} onClick={() => {
            menu.close(false)
            insert(item.id)
          }}>{item.name}</MenuItem>
        ))}
      </Menu>
    </>
  )
}

function safeDecode(href: string): string {
  try {
    return decodeURI(href)
  } catch {
    return href
  }
}
