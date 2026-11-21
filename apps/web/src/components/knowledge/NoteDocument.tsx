import {
  Alert01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Folder01Icon,
  Copy01Icon,
  RefreshIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type { RepoFileResult } from '@manor/contracts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NoteName } from './NoteName'
import { NoteAiComposer } from './NoteAiUi'
import { NoteEditor, type NotePictures } from './NoteEditor'
import { pageFileDrag } from './noteImages'
import type { QuoteAction } from './NoteFormatting'
import type { NoteAi } from './useNoteAi'
import type { Components } from 'react-markdown'
import { copyText } from '../../clipboard'
import { fileTitle, noteFolder, parseNote, type NoteFrontmatter } from '../../vaultNotes'
import { Icon } from '../Icon'
import { Markdown } from '../Markdown'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'

type RemarkPlugins = React.ComponentProps<typeof Markdown>['plugins']

/**
 * The reading measure. Shared by this tab's header, prose and editor so switching
 * modes never moves the left edge or the wrap point, and by the docked Knowledge
 * panel and every other surface that renders a document (the repo files panel), so
 * prose wraps the same way wherever it is read.
 *
 * A flat width rather than a `ch` count: `ch` is the width of a zero, so the measure
 * would drift with the face (Geist's zero is a third wider than its average character,
 * which made `72ch` render as 91 characters), and the sans stack now resolves
 * differently per device. This is wider than the 70-75 a typographer would pick, on
 * a call made after seeing it: the column sits in a lot of empty space and a narrow
 * one read cramped.
 */
export const COLUMN = 'max-w-[46rem]'

/** What the editor is holding, and what it is holding it against. */
export interface EditorState {
  path: string
  /** What is in the editor right now. */
  text: string
  /** The same note as it stands on disk; null for one that has not been created yet. */
  disk: string | null
  /**
   * The revision the text is based on, sent as the save's precondition. Null means
   * create, which the server refuses if the path already exists.
   */
  base: string | null
  /** Text submitted by the pending save, while the editor may keep changing. */
  submitted?: string
  /**
   * Which opening of a note this is. A rename or a move changes `path` and keeps this, so
   * the editor stays the same document with its cursor, undo history and scroll.
   */
  document?: number
}

/** The disagreement a `stale` save reports, held until the user picks a side. */
export interface Conflict {
  revision: string
  content: string
}

interface NoteDocumentProps {
  path: string
  /** Null while the read is in flight. */
  result: RepoFileResult | null
  /** A note that exists only in this editor, not yet on disk. */
  fresh: boolean
  /**
   * The vault's absolute path, so the header can hand out the note's real one. Null
   * on a server that never said, which hides the control rather than copying a lie.
   */
  vaultRoot: string | null
  editor: EditorState | null
  dirty: boolean
  /** A save is out and unanswered. */
  saving: boolean
  /** The same, for the conflict strip's escape hatch. */
  copied: boolean
  conflict: Conflict | null
  /** A save the server would not take at all, with its reason. */
  rejected: string | null
  /** Why editing is off, when it is. Empty means it is on. */
  editBlocked: string
  plugins: RemarkPlugins
  components: Components
  /** Sending a selection to a chat, the last controls of the editor's format bar. */
  quote?: readonly QuoteAction[]
  /** AI edits of the open note. Absent where the surface does not offer them. */
  ai?: NoteAi
  /** Pictures in the note: the vault's listing and how a paste or drop saves one. */
  pictures?: NotePictures | undefined
  onChange: (text: string) => void
  onFollowNote: (target: string) => void
  linkError: string | null
  rename: React.ComponentProps<typeof NoteName> | null

  onOverwrite: () => void
  onTakeTheirs: () => void
  onCopyMine: () => void
  onDismissRejection: () => void
  onBack?: () => void
  /** Dock chrome owns save and expand; the page header still names the note. */
  chrome?: 'page' | 'panel'
  /** The stage's Show sidebar button sits over this header's top-left corner. */
  clearsSidebarToggle?: boolean
}

/**
 * One note, read or edited. A single column at both times, so switching modes moves
 * the words as little as possible: same width, same left edge, same scroll position.
 */
export function NoteDocument({
  path,
  result,
  fresh,
  vaultRoot,
  editor,
  dirty,
  saving,
  copied,
  conflict,
  rejected,
  editBlocked,
  plugins,
  components,
  quote,
  ai,
  pictures,
  onChange,
  onFollowNote,
  linkError,
  rename,
  onOverwrite,
  onTakeTheirs,
  onCopyMine,
  onDismissRejection,
  onBack,
  chrome = 'page',
  clearsSidebarToggle = false,
}: NoteDocumentProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null)
  // Where the reader was, as a fraction of the column, put back after a mode switch.
  // Rough on a long note (an edited line does not sit at the same fraction as its
  // rendered self) but it beats being thrown back to the top on every ⌘E.
  const ratio = useRef(0)
  const identity = editor?.document ?? path
  const shown = useRef(identity)
  const editing = editor !== null

  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null) return
    // A different note starts at its own top; only a mode switch restores a position.
    if (shown.current !== identity) {
      shown.current = identity
      ratio.current = 0
    }
    const span = element.scrollHeight - element.clientHeight
    element.scrollTop = span <= 0 ? 0 : Math.round(ratio.current * span)
  }, [editing, identity])

  const rememberScroll = () => {
    const element = scroller.current
    if (element === null) return
    const span = element.scrollHeight - element.clientHeight
    ratio.current = span <= 0 ? 0 : element.scrollTop / span
  }
  const fileDrag = (event: React.DragEvent<HTMLDivElement>) => pageFileDrag(event.currentTarget, event.nativeEvent)

  const source = editor?.text ?? (result?.status === 'ready' ? result.content : '')
  const parsed = parseNote(path, source)
  const folders = noteFolder(path).split('/').filter(Boolean)

  return (
    <section role={chrome === 'page' ? 'main' : 'region'} aria-label="Note document" className={`relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] ${chrome === 'page' ? 'grid-rows-[auto_minmax(0,1fr)] bg-bg' : 'grid-rows-[auto_minmax(0,1fr)]'}`}>
      {chrome === 'page' ? (
      <header className={`px-3 pt-[var(--titlebar-row-pad)] pb-2 ${clearsSidebarToggle ? 'pl-[calc(1rem+var(--titlebar-inset)+44px)]' : ''}`}>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {onBack === undefined ? null : (
            <IconButton
              icon={ArrowLeft01Icon}
              label="Back to notes"
              className="hidden max-[760px]:grid"
              onClick={onBack}
            />
          )}
          <nav aria-label="Note location" className="flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-label text-muted" title={noteFolder(path) || 'Vault root'}>
            <Icon icon={Folder01Icon} size={14} className="flex-none" />
            <ol className="m-0 flex min-w-0 list-none items-center gap-1 p-0">
              {(folders.length === 0 ? ['Vault root'] : folders).map((folder, index) => (
                <li key={index} className="flex min-w-0 items-center gap-1">
                  {index === 0 ? null : <Icon icon={ArrowRight01Icon} size={10} className="flex-none text-dim" />}
                  <span className="truncate">{folder}</span>
                </li>
              ))}
            </ol>
          </nav>
          {editing || (vaultRoot !== null && !fresh) ? (
            <div role="group" aria-label="Note tools" className="flex h-8 flex-none items-center rounded-full bg-surface-2 px-1">
              {editing ? <div ref={setToolsSlot} className="flex items-center" /> : null}
              {vaultRoot === null || fresh ? null : <CopyPath absolute={`${vaultRoot}/${path}`} />}
            </div>
          ) : null}
          <span role="status" className="ml-auto flex-none pr-2 text-right text-meta text-muted" title="Changes save automatically. ⌘S saves immediately.">
            {conflict !== null || rejected !== null ? 'Not saved' : editBlocked !== '' ? 'Editing paused' : saving ? 'Saving…' : dirty ? 'Unsaved changes' : fresh ? 'New note' : !editing ? 'Opening…' : 'Saved'}
          </span>
        </div>

        {rename !== null ? (
          <div className={`mx-auto mt-3 w-full ${COLUMN} text-label text-text`}><NoteName key={path} {...rename} /></div>
        ) : null}

        {editBlocked === '' ? null : (
          <p className={`mx-auto mt-2 w-full ${COLUMN} text-meta text-muted`}>{editBlocked}</p>
        )}

        {conflict === null ? null : (
          <div className={`mx-auto mt-3 w-full ${COLUMN} rounded-xl border border-line bg-surface px-3.5 py-2.5`}>
            <p className="m-0 text-[12px] leading-relaxed text-muted">
              This note changed on disk while you were editing it. Your text is still here, so pick which one wins.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button size="small" variant="primary" disabled={saving} onClick={onOverwrite}>
                {saving ? 'Saving…' : 'Overwrite theirs'}
              </Button>
              <Button size="small" className="inline-flex items-center gap-1.5" onClick={onTakeTheirs}>
                <Icon icon={RefreshIcon} size={13} />
                Reload theirs
              </Button>
              <Button size="small" variant="ghost" className="inline-flex items-center gap-1.5" onClick={onCopyMine}>
                <Icon icon={copied ? Tick02Icon : Copy01Icon} size={13} />
                {copied ? 'Copied' : 'Copy mine'}
              </Button>
            </div>
          </div>
        )}

        {rejected === null ? null : (
          <div className={`mx-auto mt-3 flex w-full ${COLUMN} items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] px-3.5 py-2.5`}>
            <p className="m-0 flex-1 text-[12px] leading-relaxed text-danger">{rejected}</p>
            <Button size="small" variant="ghost" onClick={onDismissRejection}>
              Dismiss
            </Button>
          </div>
        )}
      </header>
      ) : conflict === null && rejected === null && editBlocked === '' ? <div /> : (
        <div className="border-b border-line px-3 py-2">
          {editBlocked === '' ? null : <p className="m-0 text-meta text-muted">{editBlocked}</p>}
          {conflict === null ? null : (
            <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
              <p className="m-0 text-[12px] leading-relaxed text-muted">
                This note changed on disk while you were editing it. Your text is still here, so pick which one wins.
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button size="small" variant="primary" disabled={saving} onClick={onOverwrite}>
                  {saving ? 'Saving…' : 'Overwrite theirs'}
                </Button>
                <Button size="small" className="inline-flex items-center gap-1.5" onClick={onTakeTheirs}>
                  <Icon icon={RefreshIcon} size={13} />
                  Reload theirs
                </Button>
                <Button size="small" variant="ghost" className="inline-flex items-center gap-1.5" onClick={onCopyMine}>
                  <Icon icon={copied ? Tick02Icon : Copy01Icon} size={13} />
                  {copied ? 'Copied' : 'Copy mine'}
                </Button>
              </div>
            </div>
          )}
          {rejected === null ? null : (
            <div className="flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] px-3.5 py-2.5">
              <p className="m-0 flex-1 text-[12px] leading-relaxed text-danger">{rejected}</p>
              <Button size="small" variant="ghost" onClick={onDismissRejection}>Dismiss</Button>
            </div>
          )}
        </div>
      )}

      <div ref={scroller} onScroll={rememberScroll} onDragOver={editing ? fileDrag : undefined} onDrop={editing ? fileDrag : undefined} className={`min-h-0 min-w-0 overflow-y-auto ${chrome === 'page' ? 'px-10 py-7 max-[760px]:px-6' : 'px-8 py-4'} ${editing && ai !== undefined ? 'pb-24' : ''}`}>
        {chrome === 'page' ? (
          <div className={`mx-auto mb-4 w-full ${COLUMN}`}>
            <h1 className="m-0 font-display text-[clamp(26px,4vw,34px)] leading-[1.15] font-medium tracking-[-0.02em] wrap-anywhere text-text">
              {fileTitle(path)}
            </h1>
            {parsed.frontmatter === null || editing ? null : <div className="mt-3"><Chips front={parsed.frontmatter} /></div>}
          </div>
        ) : null}
        {linkError === null ? null : <p role="alert" className={`mx-auto mb-4 w-full ${COLUMN} text-[13px] text-danger`}>{linkError}</p>}
        {editing ? (
          <div className="min-w-0 w-full text-[16px] leading-[1.7] text-text">
            <NoteEditor toolsSlot={toolsSlot} path={editor.path} {...(editor.document === undefined ? {} : { document: editor.document })} text={editor.text} onChange={onChange} onFollowNote={onFollowNote} {...(quote === undefined ? {} : { quote })} {...(ai === undefined ? {} : { ai })} {...(pictures === undefined ? {} : { pictures })} />
          </div>
        ) : (
          <NoteReader path={path} result={result} body={parsed.body} plugins={plugins} components={components} />
        )}
      </div>
      {editing && ai !== undefined ? <NoteAiComposer ai={ai} /> : null}
    </section>
  )
}

/**
 * Hands out the note's real path on disk. The one thing this tab knows that nothing
 * else in Manor does, and the thing you want the second you need to point a persona,
 * a terminal or Obsidian at the note you are reading.
 */
function CopyPath({ absolute }: { absolute: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), state === 'copied' ? 1_500 : 2_500)
    return () => clearTimeout(timer)
  }, [state])

  const icon = state === 'copied' ? Tick02Icon : state === 'failed' ? Alert01Icon : Copy01Icon

  return (
    <IconButton
      icon={icon}
      iconSize={14}
      size={28}
      className={state === 'failed' ? 'rounded-full text-danger hover:text-danger' : 'rounded-full'}
      swapKey={state}
      label="Copy the note's full path"
      // A refusal from the clipboard says so on the button. Silence here is how a
      // dead copy control went unnoticed for weeks.
      title={state === 'failed' ? 'Could not reach the clipboard' : absolute}
      onClick={() => {
        void copyText(absolute).then((ok) => setState(ok ? 'copied' : 'failed'))
      }}
    />
  )
}

function NoteReader({
  path,
  result,
  body,
  plugins,
  components,
}: {
  path: string
  result: RepoFileResult | null
  body: string
  plugins: RemarkPlugins
  components: Components
}) {
  if (result === null) return <DocumentMessage>Opening {path}…</DocumentMessage>

  switch (result.status) {
    case 'ready':
      return body.trim() === '' ? (
        <DocumentMessage>This note is empty.</DocumentMessage>
      ) : (
        <article className={`mx-auto w-full ${COLUMN} text-[15px] leading-[1.7] text-text`}>
          <Markdown text={body} variant="document" plugins={plugins} components={components} />
        </article>
      )
    case 'too_large':
      return (
        <DocumentMessage>
          This note is {formatBytes(result.size)}. Manor opens notes up to {formatBytes(result.maxSize)}.
        </DocumentMessage>
      )
    case 'binary':
      return <DocumentMessage>This file is not text, so there is nothing to read here.</DocumentMessage>
    case 'unavailable':
      return <DocumentMessage>{result.message}</DocumentMessage>
  }
}

function Chips({ front }: { front: NoteFrontmatter }) {
  const chips = [
    ...(front.type === null ? [] : [{ key: `type:${front.type}`, label: front.type }]),
    ...(front.status === null ? [] : [{ key: `status:${front.status}`, label: front.status }]),
    ...(front.date === null ? [] : [{ key: `date:${front.date}`, label: front.date }]),
    ...front.tags.map((tag) => ({ key: `tag:${tag}`, label: tag })),
  ]
  if (chips.length === 0) return null

  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {chips.map((chip) => (
        <li
          key={chip.key}
          className="rounded-md bg-surface-2 px-1.5 py-0.5 text-meta leading-[1.5] text-muted"
        >
          {chip.label}
        </li>
      ))}
    </ul>
  )
}

function DocumentMessage({ children }: { children: React.ReactNode }) {
  return <p className={`mx-auto m-0 w-full ${COLUMN} text-[13px] leading-relaxed text-muted`}>{children}</p>
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}
