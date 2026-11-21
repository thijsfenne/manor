import { editorMemory, type RenameRequest } from './knowledgeDrafts'
import { buildNoteIndex, resolveNote } from '@manor/client-runtime/vault-notes'
import { insideVaultEntry, movedVaultPath } from '@manor/client-runtime/state'
import { quoteFromNote } from '@manor/client-runtime/message-quotes'
import { driverForModel, modelLabel, type NoteQuote } from '@manor/contracts'
import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  BubbleChatAddIcon,
  Cancel01Icon,
  QuoteDownIcon,
  SidebarLeftIcon,
} from '@hugeicons/core-free-icons'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Components } from 'react-markdown'
import { copyText } from '../../clipboard'
import type { VaultState } from '../../state'
import type { ConnectionStatus } from '../../useWorkspace'
import { FILES_TREE_WIDTH } from '../../useFilesPanel'
import {
  isMissingNote,
  noteTarget,
  remarkCallouts,
  remarkWikilinks,
} from '../../vaultNotes'
import { baseName } from '../fileMark'
import { ExternalLink } from '../ExternalLink'
import { DOCK_PANEL_SHELL, dockPanelLayoutClass } from '../ui/dockPanel'
import { DockPanelAside } from '../ui/DockPanelAside'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import { useCollapsed } from '../../chatCollapsed'
import { useStableCallback } from '../../useStableCallback'
import { activeTab, closeTab, moveTab, openInActive, openInNew, pruneTabs, renamePaths, selectTab, useCloseTabKey, useStoredTabs } from '../../contentTabs'
import { ContentTabStrip } from '../ContentTabStrip'
import { useTopBarSlot } from '../TopBar'
import { NoteName } from './NoteName'
import { NoteDocument, type Conflict, type EditorState } from './NoteDocument'
import type { QuoteAction } from './NoteFormatting'
import { ENTRY_DRAG, filterNotes, NoteRail } from './NoteRail'
import { useNoteAi } from './useNoteAi'
import type { NotePictures } from './NoteEditor'

const NO_IMAGES: Readonly<Record<string, string>> = {}

const INBOX = 'inbox'
/** Where the vault home keeps its note tabs across a restart. */
export const NOTE_TABS_KEY = 'manor:knowledge-tabs'
export const NOTE_AUTOSAVE_MS = 500
/** How often a clean open note is re-read from disk while Knowledge is up. */
export const NOTE_REFRESH_MS = 1_000

type NoteRefreshGate = {
  visible: boolean
  live: boolean
  path: string | null
  fresh: string | null
  dirty: boolean
  saving: boolean
  conflict: boolean
  pending: boolean
  reading: boolean
}

/** Whether the open note should be re-read from disk this tick. */
export function canRefreshOpenNote(gate: NoteRefreshGate): gate is NoteRefreshGate & { path: string } {
  return (
    gate.visible &&
    gate.live &&
    gate.path !== null &&
    gate.fresh === null &&
    !gate.dirty &&
    !gate.saving &&
    !gate.conflict &&
    !gate.pending &&
    !gate.reading
  )
}

const SPLIT_COLUMNS = 'grid-cols-[var(--knowledge-tree-width)_minmax(0,1fr)]'

/**
 * Which folders the rail has open, held outside the component for the same reason
 * composer drafts are: switching to another view unmounts this panel. The open note
 * lives in workspace state and comes back on its own, so a tree that collapsed under
 * it was the only thing that did not. Tab lifetime only, not storage — a reload
 * re-lists the vault and may as well start from a closed tree.
 */
let openFolderMemory: ReadonlySet<string> = new Set()

/** Numbers each opening of a note, so a rename or a move keeps the same editor document. */
let documents = 0
const nextDocument = () => (documents += 1)

export interface KnowledgeDockChrome {
  width: number
  compact?: boolean
  expanded: boolean
  overlay?: boolean
  revealed?: boolean
  resizing: boolean
  resizeProps: ComponentPropsWithoutRef<'div'>
  onToggleExpanded: () => void
  shortcutsActive?: boolean
  onClosePanel: () => void
}

interface KnowledgePanelProps {
  vault: VaultState
  status: ConnectionStatus
  onList: () => void
  onCreateFolder: (path: string) => boolean
  onDelete: (requestId: string, path: string) => boolean
  onRename: (requestId: string, path: string, newPath: string, baseRevision: string) => boolean
  /** Moves a note or folder into `folder` (`''` is the top level); see `Manor.moveVaultEntry`. */
  onMove: (requestId: string, path: string, folder: string, notify: boolean) => boolean
  onOpen: (path: string) => boolean
  onSave: (path: string, content: string, baseRevision: string | null) => boolean
  onClearWrite: () => void
  /** Starts an AI edit of the open note; the answer lands in `vault.noteEdits`. See `Manor.editVaultNote`. */
  onEditNote: (requestId: string, note: string, selection: { from: number; to: number } | null, instruction: string) => boolean
  onForgetNoteEdit: (requestId: string, cancel: boolean) => void
  /** Saves a pasted or dropped picture into the vault; the answer lands in `vault.imageSaves`. */
  onSaveImage?: (requestId: string, notePath: string, name: string, dataUrl: string) => boolean
  onForgetImageSave?: (requestId: string) => void
  /** The model Settings names for note edits. */
  noteAiModel: string
  onClose: () => void
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  /**
   * The workspace sidebar's slot for the note tree on the desktop vault home. Absent on
   * the phone and in a dock, where the tree stays in this panel's own column.
   */
  sidebarSlot?: HTMLElement | null
  sidebarActionSlot?: HTMLElement | null
  /** Per-chat editor memory, so two docks do not share one draft. */
  memoryKey?: string
  dock?: KnowledgeDockChrome
  /**
   * The vault home's hold on ⌘S and `/`, which listen on the window. Off while Settings
   * covers the workspace without unmounting it. A dock carries its own in `dock`.
   */
  shortcutsActive?: boolean
  /** Docked per-chat path. Absent on the vault home, which uses the last vault read. */
  selectedPath?: string | null
  onRememberPath?: (path: string | null) => void
  onQuote?: (quote: NoteQuote) => void
  onAddToSideChat?: (quote: NoteQuote) => void
  /**
   * A note asked for from outside this panel, the ⌘K palette's pick. Opened once, the
   * way a tree click opens it (unsaved edits save first); `onOpenRequestHandled` then
   * clears it, so a later visit does not reopen it over a note picked since.
   */
  openRequest?: { path: string; id: number } | null
  onOpenRequestHandled?: (id: number) => void
}

type PendingAction =
  | { kind: 'open'; path: string }
  | { kind: 'new'; path: string }
  | { kind: 'close' }
  | { kind: 'closePanel' }

/**
 * The Knowledge surface: the user's Obsidian vault. Stage home when no thread is open,
 * otherwise the same tree and live-preview editor docked beside the chat like Files.
 */
export function KnowledgePanel({
  vault,
  status,
  sidebarCollapsed = false,
  onToggleSidebar,
  sidebarSlot,
  sidebarActionSlot,
  onList,
  onCreateFolder,
  onDelete,
  onRename,
  onMove,
  onOpen,
  onSave,
  onClearWrite,
  onEditNote,
  onForgetNoteEdit,
  onSaveImage,
  onForgetImageSave,
  noteAiModel,
  onClose,
  memoryKey,
  dock,
  shortcutsActive: homeShortcutsActive = true,
  selectedPath: selectedPathProp,
  onRememberPath: rememberPathProp,
  onQuote,
  onAddToSideChat,
  openRequest,
  onOpenRequestHandled,
}: KnowledgePanelProps) {
  const draftKey = memoryKey ?? vault.root
  const [filter, setFilter] = useState('')
  const [renamePath, setRenamePath] = useState<string | null>(() => draftKey === null ? null : editorMemory.get(draftKey)?.renameRequest?.path ?? null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(() => {
    const pending = draftKey === null ? null : editorMemory.get(draftKey)?.renameRequest ?? null
    if (pending === null || pending.phase === 'waiting') return pending
    const answered = vault.rename?.requestId === pending.requestId && vault.rename.result !== null
    return { ...pending, phase: answered ? 'sent' : 'retry' }
  })
  const [linkError, setLinkError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(openFolderMemory))
  const [editor, setEditor] = useState<EditorState | null>(() =>
    draftKey === null ? null : editorMemory.get(draftKey)?.editor ?? null,
  )
  const [fresh, setFresh] = useState<string | null>(() =>
    draftKey === null ? null : editorMemory.get(draftKey)?.fresh ?? null,
  )
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [copied, setCopied] = useState(false)
  /** The open note was deleted while it held unsaved text: shown, never saved back. */
  const [gone, setGone] = useState<string | null>(null)
  // A dock folds its tree per chat; the vault home has no chat and keeps it in the component.
  const [treeHidden, setTreeHidden] = useCollapsed(dock === undefined ? null : memoryKey, 'knowledge-tree')
  const [compactTree, setCompactTree] = useState(false)
  const lastNoteRead = useRef<string | null | undefined>(undefined)
  const lastNotePath = useRef<string | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const refreshGate = useRef({
    path: null as string | null,
    fresh: null as string | null,
    dirty: false,
    saving: false,
    conflict: false,
    pending: false,
    reading: false,
    live: false,
  })
  const pendingSave = useRef<{ path: string; text: string } | null>(null)
  const consumedRename = useRef(vault.rename?.result?.status === 'renamed' ? vault.rename.requestId : null)
  const consumedDelete = useRef(vault.deleted?.requestId ?? null)
  const consumedMove = useRef(vault.moved?.requestId ?? null)
  /** The move this panel sent, whose landing expands the destination and selects the note. */
  const ownMove = useRef<string | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  const topBar = useTopBarSlot()
  // The desktop vault home keeps its open notes as tabs in the top bar, a dock keeps its
  // own per chat in its header, and the active tab is the note shown. The phone keeps one.
  const homeTabbed = dock === undefined && sidebarSlot !== undefined && topBar !== null
  const tabsKey = homeTabbed ? NOTE_TABS_KEY : dock !== undefined && memoryKey !== undefined ? `${NOTE_TABS_KEY}:${memoryKey}` : null
  const tabbed = tabsKey !== null
  const [noteTabs, changeNoteTabs] = useStoredTabs(tabsKey)
  const activeNoteTab = activeTab(noteTabs)
  const selectedPath = tabbed ? activeNoteTab?.path ?? null : selectedPathProp
  // Every route that opens a note (the tree, a link, the palette, a rename) lands here:
  // the active tab takes it, or switches to the tab that already holds it.
  const rememberTab = useCallback((next: string | null) => {
    if (next !== null) changeNoteTabs((state) => openInActive(state, next))
  }, [changeNoteTabs])
  const onRememberPath = tabbed ? rememberTab : rememberPathProp
  const tabEvents = useRef({ moved: vault.moved?.requestId ?? null, renamed: vault.rename?.requestId ?? null, deleted: vault.deleted?.requestId ?? null })
  /** The listing tabs were last checked against; null until the first one after mount. */
  const prunedListing = useRef<readonly string[] | null>(null)

  const live = status === 'live'
  const files = vault.files
  const { tree, expandAll } = useMemo(() => filterNotes(files ?? [], filter, vault.folders), [files, filter, vault.folders])
  const openFolders = useMemo(() => (expandAll.length === 0 ? expanded : new Set(expandAll)), [expandAll, expanded])

  const path = editor?.path ?? fresh ?? (selectedPath !== undefined ? selectedPath : vault.note?.path ?? null)
  if (lastNotePath.current !== path) {
    lastNotePath.current = path
    lastNoteRead.current = undefined
  }
  const result = fresh === null && vault.note?.path === path ? vault.note.result ?? null : null
  // Seed during render so a ready note never paints `NoteReader` first. An effect
  // would commit the markdown view, then swap it for the editor after paint.
  // A clean buffer must not follow a lagging read: after our own save `vault.note`
  // still holds the last read, and adopting it would rewind the revision so the
  // next autosave hits `stale`.
  if (path !== null && fresh === null && result?.status === 'ready' && live) {
    if (editor === null || editor.path !== path) {
      setEditor({ path, text: result.content, disk: result.content, base: result.revision ?? null, document: nextDocument() })
      lastNoteRead.current = result.revision ?? null
    }
  }
  const write = vault.write?.path === path ? vault.write : null
  const writeResult = write?.result ?? null
  const saving = write !== null && writeResult === null
  const conflict: Conflict | null =
    writeResult?.status === 'stale' ? { revision: writeResult.revision, content: writeResult.content } : null
  const isGone = gone !== null && editor?.path === gone
  const rejected = isGone
    ? 'This note was moved to the trash. Your unsaved text is only here now; copy it before you close the note.'
    : writeResult?.status === 'rejected' ? writeResult.message : null
  const dirty = editor !== null && (fresh !== null || editor.text !== (editor.disk ?? ''))
  const ai = useNoteAi({
    editor,
    setEditor,
    live,
    saving,
    refused: conflict !== null || rejected !== null,
    writeResult,
    results: vault.noteEdits,
    model: modelLabel(driverForModel(noteAiModel) ?? 'claude', noteAiModel),
    onAsk: onEditNote,
    onForget: onForgetNoteEdit,
    onSave,
    onClearWrite,
    onSaved: onOpen,
  })
  // A proposal is read against the text in the editor. A re-read would swap that text
  // under it, and would hide a change on disk that Accept has to be refused for.
  const aiHolds = ai.state.phase !== 'idle' && ai.state.phase !== 'failed'
  const compact = dock?.compact === true
  const showTree = path === null || (compact ? compactTree : !treeHidden)
  const splitColumns = showTree && !compact
  const shortcutsActive = dock === undefined ? homeShortcutsActive : dock.shortcutsActive !== false
  refreshGate.current = {
    path,
    fresh,
    dirty,
    saving,
    conflict: conflict !== null,
    pending: pendingAction !== null || renameRequest !== null || aiHolds,
    reading: vault.note?.path === path && vault.note.result === null,
    live,
  }

  useEffect(() => {
    openFolderMemory = expanded
  }, [expanded])

  useEffect(() => {
    if (draftKey === null) return
    if (editor === null) editorMemory.delete(draftKey)
    else editorMemory.set(draftKey, { editor, fresh, renameRequest })
  }, [draftKey, editor, fresh, renameRequest])

  useEffect(() => {
    if (fresh !== null || result?.status !== 'ready' || path === null) return
    const revision = result.revision ?? null
    if (lastNoteRead.current === undefined) {
      lastNoteRead.current = revision
      return
    }
    if (revision === lastNoteRead.current) return
    lastNoteRead.current = revision
    setEditor((current) => {
      if (current === null || current.path !== path) return current
      if (current.text !== (current.disk ?? '')) return current
      if (current.disk === result.content && current.base === revision) return current
      return { ...current, text: result.content, disk: result.content, base: revision }
    })
  }, [result, path, fresh])

  useEffect(() => {
    if (vault.status === 'ready' && live) onList()
  }, [vault.status, live, onList])

  // Disk is the only truth, but the last read is what the editor shows. Re-read the
  // open note while this panel is up so an agent or Obsidian write appears without
  // restarting Manor. A dirty buffer stays sovereign; a read already in flight is
  // not stacked.
  useEffect(() => {
    if (!live) return
    const pull = () => {
      if (window.document.visibilityState !== 'visible') return
      const next = { visible: true as const, ...refreshGate.current }
      if (!canRefreshOpenNote(next)) return
      onOpen(next.path)
    }
    pull()
    const timer = window.setInterval(pull, NOTE_REFRESH_MS)
    const onVisible = () => {
      if (window.document.visibilityState !== 'visible') return
      onList()
      pull()
    }
    window.document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(timer)
      window.document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [live, onList, onOpen])

  useEffect(() => setCompactTree(false), [path])

  const showFolders = useCallback((notePath: string) => {
    const folders = notePath.split('/').slice(0, -1)
    if (folders.length === 0) return
    setExpanded((current) => {
      const merged = new Set(current)
      for (let depth = 1; depth <= folders.length; depth += 1) merged.add(folders.slice(0, depth).join('/'))
      return merged
    })
  }, [])

  useEffect(() => {
    if (selectedPath === undefined || selectedPath === null) return
    if (editor?.path === selectedPath || fresh === selectedPath || vault.note?.path === selectedPath) return
    if (dirty || saving || pendingAction !== null || renameRequest !== null) return
    if (!live) return
    if (!onOpen(selectedPath)) return
    showFolders(selectedPath)
  }, [selectedPath, editor?.path, fresh, vault.note?.path, dirty, saving, pendingAction, renameRequest, live, onOpen, showFolders])

  const take = useCallback(
    (next: PendingAction) => {
      if (next.kind === 'open') {
        setLinkError(null)
        setEditor(null)
        setFresh(null)
        onClearWrite()
        onRememberPath?.(next.path)
        if (!onOpen(next.path)) return
        showFolders(next.path)
        return
      }
      if (next.kind === 'new') {
        setFilter('')
        setLinkError(null)
        setEditor({ path: next.path, text: '', disk: null, base: null, document: nextDocument() })
        setFresh(next.path)
        onClearWrite()
        onRememberPath?.(next.path)
        return
      }
      setEditor(null)
      setFresh(null)
      onRememberPath?.(null)
      if (next.kind === 'closePanel') dock?.onClosePanel()
      else onClose()
    },
    [onOpen, onClearWrite, showFolders, onClose, dock, onRememberPath],
  )

  const save = useCallback(
    (base: string | null) => {
      if (editor === null || !live || saving || isGone || (renameRequest?.phase === 'sent' || renameRequest?.phase === 'retry')) return false
      const attempt = { path: editor.path, text: editor.text }
      pendingSave.current = attempt
      const sent = onSave(editor.path, editor.text, base)
      if (!sent) pendingSave.current = null
      return sent
    },
    [editor, live, saving, isGone, onSave, renameRequest],
  )

  const leave = useCallback(
    (next: PendingAction) => {
      if (renameRequest !== null) return
      if (next.kind === 'open' && next.path === path) {
        setCompactTree(false)
        return
      }
      if (!dirty || isGone) {
        setPendingAction(null)
        setGone(null)
        take(next)
        return
      }
      setPendingAction(next)
      if (saving || conflict !== null || rejected !== null) return
      if (!save(editor.base)) setPendingAction(null)
    },
    [path, dirty, isGone, editor, saving, conflict, rejected, save, take, renameRequest],
  )

  // A tab picked, closed or restored names a note the panel is not showing yet. Leaving
  // goes through `leave`, so unsaved text reaches disk before the note is swapped out.
  // An empty tab (the strip's plus) shows the empty stage until a note is picked into it.
  // `leave` changes identity with every parent render (a dock's chrome is a fresh object),
  // and a store update can re-render before the swap lands, so the effect follows data only.
  const leaveForTab = useStableCallback(leave)
  useEffect(() => {
    if (!tabbed || !live || renameRequest !== null || dock?.revealed === false) return
    const target = activeNoteTab?.path
    if (target === undefined || target === path) return
    if (target === null) {
      // A pick made while a save is in flight lands in this tab once the save does.
      if (pendingAction === null) leaveForTab({ kind: 'close' })
      return
    }
    if ((pendingAction?.kind === 'open' || pendingAction?.kind === 'new') && pendingAction.path === target) return
    leaveForTab({ kind: 'open', path: target })
  }, [tabbed, live, renameRequest, dock?.revealed, activeNoteTab?.path, path, pendingAction, leaveForTab])

  // Tabs follow their notes. A rename or a move made anywhere carries every tab it
  // touches; a note gone from the listing closes its tab quietly. The note on screen
  // keeps its tab until the panel itself lets go (a new note is not listed until saved,
  // and a deleted note with unsaved text stays readable). The first listing after a
  // restart spares nothing, so a tab whose note vanished while Manor was closed goes.
  useEffect(() => {
    if (!tabbed) return
    const seen = tabEvents.current
    const moved = vault.moved
    if (moved !== undefined && moved.requestId !== seen.moved) {
      seen.moved = moved.requestId
      changeNoteTabs((state) => renamePaths(state, (target) => insideVaultEntry(target, moved.path) ? movedVaultPath(target, moved.path, moved.newPath) : target))
    }
    const renamed = vault.rename
    if (renamed?.result?.status === 'renamed' && renamed.requestId !== seen.renamed) {
      seen.renamed = renamed.requestId
      changeNoteTabs((state) => renamePaths(state, (target) => target === renamed.path ? renamed.newPath : target))
    }
    const deleted = vault.deleted
    if (deleted !== undefined && deleted.requestId !== seen.deleted) {
      seen.deleted = deleted.requestId
      changeNoteTabs((state) => pruneTabs(state, (target) => !insideVaultEntry(target, deleted.path), dirty ? path : null))
    }
  }, [tabbed, vault.moved, vault.rename, vault.deleted, dirty, path, changeNoteTabs])

  useEffect(() => {
    if (!tabbed || files === null || vault.truncated || prunedListing.current === files) return
    const first = prunedListing.current === null
    prunedListing.current = files
    const listed = new Set(files)
    changeNoteTabs((state) => pruneTabs(state, (target) => listed.has(target), first ? null : path))
  }, [tabbed, files, vault.truncated, path, changeNoteTabs])

  useEffect(() => {
    if (openRequest === undefined || openRequest === null || !live) return
    onOpenRequestHandled?.(openRequest.id)
    leave({ kind: 'open', path: openRequest.path })
  }, [openRequest, live, leave, onOpenRequestHandled])

  useEffect(() => {
    if (writeResult?.status !== 'saved' || editor === null) return
    const attempt = pendingSave.current
    if (attempt === null || attempt.path !== editor.path) return
    pendingSave.current = null
    const revision = writeResult.revision
    setEditor((current) => (current === null ? null : { ...current, disk: attempt.text, base: revision }))
    if (fresh !== null) {
      setFresh(null)
      onList()
      onOpen(fresh)
      showFolders(fresh)
    } else if (pendingAction === null) {
      // Files re-reads after save so the last snapshot cannot rewind a clean buffer.
      onOpen(editor.path)
    }
    if (pendingAction !== null && editor.text === attempt.text) {
      const next = pendingAction
      setPendingAction(null)
      take(next)
    } else if (pendingAction !== null) {
      save(revision)
    }
  }, [writeResult, editor, fresh, pendingAction, onList, onOpen, showFolders, save, take])

  useEffect(() => {
    if (writeResult?.status !== 'rejected' && writeResult?.status !== 'stale') return
    pendingSave.current = null
    if (writeResult.status === 'rejected') setPendingAction(null)
  }, [writeResult])

  useEffect(() => {
    if (!dirty || editor === null || saving || conflict !== null || rejected !== null || pendingAction !== null) return
    const timer = window.setTimeout(() => save(editor.base), NOTE_AUTOSAVE_MS)
    return () => window.clearTimeout(timer)
  }, [dirty, editor, saving, conflict, rejected, pendingAction, save])

  useEffect(() => {
    if (renameRequest?.phase === 'retry') {
      if (live && renameRequest.baseRevision !== undefined && onRename(renameRequest.requestId, renameRequest.path, renameRequest.newPath, renameRequest.baseRevision)) {
        setRenameRequest({ ...renameRequest, phase: 'sent' })
      }
      return
    }
    if (renameRequest?.phase !== 'waiting') return
    if (!live || conflict !== null || rejected !== null) {
      setRenameError(!live ? 'Reconnect before renaming.' : 'Resolve the save error before renaming.')
      setRenameRequest(null)
      return
    }
    if (dirty || saving || editor === null || editor.base === null || editor.path !== renameRequest.path) return
    if (!onRename(renameRequest.requestId, renameRequest.path, renameRequest.newPath, editor.base)) {
      setRenameError('Reconnect before renaming.')
      setRenameRequest(null)
      return
    }
    setRenameRequest({ ...renameRequest, phase: 'sent', baseRevision: editor.base })
  }, [renameRequest, live, conflict, rejected, dirty, saving, editor, onRename])

  useEffect(() => {
    if (renameRequest?.phase !== 'sent') return
    const answer = vault.rename
    if (answer?.requestId === renameRequest.requestId && answer.result !== null) {
      setRenameRequest(null)
      if (answer.result.status === 'rejected') { setRenameError(answer.result.message); return }
      setRenamePath(null)
      setRenameError(null)
      setFilter('')
      setEditor((current) => current?.path === answer.path ? { ...current, path: answer.newPath } : current)
      setFresh(null)
      onRememberPath?.(answer.newPath)
      onOpen(answer.newPath)
      showFolders(answer.newPath)
      onList()
    } else if (!live) {
      setRenameRequest({ ...renameRequest, phase: 'retry' })
      setRenameError('Connection lost. The new name will be checked after reconnecting.')
    }
  }, [renameRequest, vault.rename, live, onRememberPath, onOpen, showFolders, onList])

  // A note can be remembered in several chats. Each mounted editor follows the
  // same file identity, while keeping its own unsaved text and revision.
  useEffect(() => {
    const answer = vault.rename
    if (answer?.result?.status !== 'renamed' || consumedRename.current === answer.requestId) return
    consumedRename.current = answer.requestId
    if (editor?.path !== answer.path) return
    setEditor((current) => current?.path === answer.path ? { ...current, path: answer.newPath } : current)
    onRememberPath?.(answer.newPath)
  }, [vault.rename, editor?.path, onRememberPath])

  // A delete from any client: a clean editor on the note, or on a note inside the
  // folder, closes. Unsaved text stays on screen marked gone, and nothing saves it back.
  useEffect(() => {
    const answer = vault.deleted
    if (answer === undefined || consumedDelete.current === answer.requestId) return
    consumedDelete.current = answer.requestId
    const open = editor?.path ?? fresh
    if (open === null || open === undefined || !insideVaultEntry(open, answer.path)) {
      if (pendingAction?.kind === 'open' && insideVaultEntry(pendingAction.path, answer.path)) setPendingAction(null)
      return
    }
    // Only a delete of this note drops its save in flight; another note's delete must not
    // swallow this note's save result.
    pendingSave.current = null
    setPendingAction(null)
    setRenamePath(null)
    if (dirty) {
      setFresh(null)
      setGone(open)
      return
    }
    setEditor(null)
    setFresh(null)
    onRememberPath?.(null)
  }, [vault.deleted, editor?.path, fresh, dirty, pendingAction, onRememberPath])

  // A move from any client: an editor on the note, or on a note inside the moved folder,
  // follows it with its text, cursor and unsaved edits. The panel that asked for the move
  // also opens the destination folder in the tree and selects the moved note.
  useEffect(() => {
    const answer = vault.moved
    if (answer === undefined || consumedMove.current === answer.requestId) return
    consumedMove.current = answer.requestId
    const swap = (target: string) => movedVaultPath(target, answer.path, answer.newPath)
    const open = editor?.path ?? fresh
    setEditor((current) => current === null || !insideVaultEntry(current.path, answer.path) ? current : { ...current, path: swap(current.path) })
    setFresh((current) => current === null ? null : swap(current))
    setGone((current) => current === null ? null : swap(current))
    setRenamePath((current) => current === null ? null : swap(current))
    setPendingAction((current) => current?.kind === 'open' || current?.kind === 'new' ? { ...current, path: swap(current.path) } : current)
    setExpanded((current) => new Set([...current].map(swap)))
    if (pendingSave.current !== null) pendingSave.current = { ...pendingSave.current, path: swap(pendingSave.current.path) }
    if (open !== null && open !== undefined && insideVaultEntry(open, answer.path)) onRememberPath?.(swap(open))
    if (ownMove.current !== answer.requestId) return
    ownMove.current = null
    showFolders(answer.newPath)
    if (answer.kind === 'note' && (open === null || open === undefined || !insideVaultEntry(open, answer.path))) leave({ kind: 'open', path: answer.newPath })
  }, [vault.moved, editor?.path, fresh, onRememberPath, showFolders, leave])

  const startMove = useCallback((requestId: string, target: string, folder: string, notify: boolean) => {
    const sent = onMove(requestId, target, folder, notify)
    if (sent) ownMove.current = requestId
    return sent
  }, [onMove])

  const beginRename = (target: string) => {
    if (!live || renameRequest !== null || pendingAction !== null) return
    setRenamePath(target)
    setRenameError(null)
    if (target !== path) leave({ kind: 'open', path: target })
  }

  const submitRename = (name: string) => {
    if (path === null || editor === null || editor.path !== path || renameRequest !== null || pendingAction !== null) return
    if (!live) { setRenameError('Reconnect before renaming.'); return }
    const trimmed = name.trim()
    const filename = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`
    const parent = path.split('/').slice(0, -1).join('/')
    const newPath = parent === '' ? filename : `${parent}/${filename}`
    if (!trimmed || trimmed.startsWith('.') || /[/\\\0]/.test(trimmed) || new TextEncoder().encode(filename).length > 255 || newPath.length > 1_000) {
      setRenameError('Use a shorter name without slashes or a leading dot.'); return
    }
    if (newPath === path) { setRenamePath(null); setRenameError(null); return }
    if ([...(files ?? []), ...(vault.folders ?? [])].some((entry) => entry !== path && entry.toLowerCase() === newPath.toLowerCase())) {
      setRenameError('A file or folder with that name already exists.'); return
    }
    setRenameError(null)
    setRenameRequest({ requestId: crypto.randomUUID(), path, newPath, phase: 'waiting' })
  }

  const renameProps = {
    path: path ?? '',
    editing: renamePath === path && path !== null && editor !== null,
    busy: renameRequest !== null,
    disabled: !live || editor === null || pendingAction !== null || isGone,
    error: renameError,
    onStart: () => { if (path !== null) beginRename(path) },
    onCancel: () => { setRenamePath(null); setRenameError(null) },
    onSubmit: submitRename,
  }

  const toggleFolder = useCallback((folder: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(folder)) next.add(folder)
      return next
    })
  }, [])

  const index = useMemo(() => buildNoteIndex(files ?? []), [files])
  const followNote = useCallback((target: string) => {
    const resolved = resolveNote(index, target)
    if (resolved === null) {
      setLinkError(`“${target}” was not found in this vault. Check the linked note's name.`)
      return
    }
    setFilter('')
    leave({ kind: 'open', path: resolved })
  }, [index, leave])
  const plugins = useMemo(
    () => [remarkWikilinks((target) => resolveNote(index, target)), remarkCallouts()],
    [index],
  )
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const target = noteTarget(href)
        if (target !== null) {
          return (
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-left text-[var(--accent-fg)] underline underline-offset-2 [font:inherit] hover:no-underline"
              onClick={() => leave({ kind: 'open', path: target })}
            >
              {children}
            </button>
          )
        }
        if (isMissingNote(href)) {
          return (
            <span
              className="text-dim underline decoration-dotted underline-offset-2"
              title="No note has this name"
            >
              {children}
            </span>
          )
        }
        return (
          <ExternalLink
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--accent-fg)] underline underline-offset-2 hover:no-underline"
          >
            {children}
          </ExternalLink>
        )
      },
    }),
    [leave],
  )

  useEffect(() => {
    if (!shortcutsActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      // Mod-Shift-S is strikethrough inside a note, so only the plain key saves.
      if (meta && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        if (editor !== null && dirty && !saving) save(editor.base)
        return
      }
      if (event.key === '/' && !meta && !typing(event.target)) {
        event.preventDefault()
        filterRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [editor, dirty, saving, save, shortcutsActive])

  const copyMine = () => {
    if (editor === null) return
    void copyText(editor.text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    })
  }

  // The selection's way into a chat, as the last controls of the note's format bar.
  const quoteActions: QuoteAction[] = path === null ? [] : [
    ...(onQuote === undefined ? [] : [{
      id: 'quote', label: 'Quote selection', short: 'Quote', icon: QuoteDownIcon,
      run: (text: string) => { const quote = quoteFromNote(path, text); if (quote !== undefined) onQuote(quote) },
    }]),
    ...(onAddToSideChat === undefined ? [] : [{
      id: 'side-chat', label: 'Add to side chat', short: 'Side chat', icon: BubbleChatAddIcon,
      run: (text: string) => { const quote = quoteFromNote(path, text); if (quote !== undefined) onAddToSideChat(quote) },
    }]),
  ]

  const pictures = useMemo<NotePictures | undefined>(() => onForgetImageSave === undefined ? undefined : {
    images: vault.images ?? NO_IMAGES,
    attachmentFolder: vault.attachmentFolder ?? null,
    saves: vault.imageSaves,
    // A note not yet on disk has no folder for the attachment rule to read.
    onSave: fresh === null && status === 'live' ? onSaveImage ?? null : null,
    onForget: onForgetImageSave,
  }, [vault.images, vault.attachmentFolder, vault.imageSaves, fresh, status, onSaveImage, onForgetImageSave])
  const documentProps = {
    path: path ?? '',
    result,
    fresh: fresh !== null,
    vaultRoot: vault.root,
    editor,
    dirty,
    saving,
    copied,
    conflict,
    rejected,
    editBlocked: editBlocked(status, result?.status),
    plugins,
    components,
    quote: quoteActions,
    ai,
    pictures,
    onChange: (text: string) => {
      if (writeResult !== null) onClearWrite()
      setEditor((current) => (current === null ? null : { ...current, text }))
    },
    rename: renameProps,
    onOverwrite: () => save(conflict?.revision ?? null),
    onTakeTheirs: () => {
      if (conflict === null) return
      setEditor((current) =>
        current === null
          ? null
          : { ...current, text: conflict.content, disk: conflict.content, base: conflict.revision },
      )
      onClearWrite()
    },
    onCopyMine: copyMine,
    onDismissRejection: isGone ? () => { setGone(null); take({ kind: 'close' }) } : onClearWrite,
  }

  /** A new note fills an empty active tab, or opens in a new tab beside whatever was open. */
  const createNote = (target: string) => {
    if (tabbed) changeNoteTabs((state) => activeTab(state)?.path === null ? openInActive(state, target) : openInNew(state, target))
    leave({ kind: 'new', path: target })
  }
  const openInNewTab = (target: string, index?: number) => changeNoteTabs((state) => openInNew(state, target, index))
  // The last tab closing leaves the empty stage, through `leave` so a draft saves first.
  // Any other close hands over to a neighbour, which the effect above opens.
  const closeNoteTab = (id: string) => {
    if (renameRequest !== null) return
    const next = closeTab(noteTabs, id)
    changeNoteTabs(() => next)
    if (next.tabs.length === 0) leave({ kind: 'close' })
  }

  // ⌘W closes the active tab while Knowledge was last pressed or focused: its tree, its
  // note or its strip. A dock is one card, found by its chat.
  useCloseTabKey(
    tabbed && shortcutsActive && noteTabs.activeId !== null,
    (element) => dock === undefined
      ? [stageRef.current, sidebarSlot ?? null, topBar?.element ?? null].some((area) => area?.contains(element) === true)
      : element.closest('[data-knowledge-panel]')?.getAttribute('data-knowledge-panel') === memoryKey,
    () => { if (noteTabs.activeId !== null) closeNoteTab(noteTabs.activeId) },
  )

  const tabStrip = !tabbed ? null : (
      <ContentTabStrip
        label="Note tabs"
        newLabel="New tab"
        slim={homeTabbed}
        disabled={!live || renameRequest !== null}
        items={noteTabs.tabs.map(({ id, path: tabPath }) => tabPath === null
          ? { id, name: 'New tab', title: 'New tab' }
          : { id, name: baseName(tabPath).replace(/\.md$/i, ''), title: tabPath, menu: [{ label: 'Rename', onSelect: () => beginRename(tabPath) }] })}
        activeId={noteTabs.activeId}
        onSelect={(id) => changeNoteTabs((state) => selectTab(state, id))}
        onClose={closeNoteTab}
        onMove={(id, index) => changeNoteTabs((state) => moveTab(state, id, index))}
        onNew={() => changeNoteTabs((state) => openInNew(state, null))}
        drop={{
          accepts: (event) => event.dataTransfer.types.includes(ENTRY_DRAG),
          // A folder dragged here is not a note to open; only listed notes are.
          read: (event) => {
            const dropped = event.dataTransfer.getData(ENTRY_DRAG)
            return files?.includes(dropped) === true ? dropped : null
          },
          onDrop: (dropped, index) => openInNewTab(dropped, index),
        }}
      />
  )
  const noteTabStrip = !homeTabbed || topBar?.element == null ? null : createPortal(
    <div data-top-bar-crumb="" className="order-1 flex min-w-0 flex-1 items-center">{tabStrip}</div>,
    topBar.element,
  )

  const rail = (
    <NoteRail
      vaultName={vault.name}
      actionSlot={sidebarActionSlot}
      folders={vault.folders ?? []}
      previews={vault.previews ?? {}}
      folderWrite={vault.folderWrite}
      deletion={vault.deletion}
      trash={vault.trash ?? null}
      onDelete={onDelete}
      onRename={beginRename}
      move={vault.move}
      onMove={startMove}
      onCreateAt={createNote}
      onCreateFolder={onCreateFolder}
      onFolderCreated={(path) => { setFilter(''); showFolders(`${path}/note.md`); onList() }}
      files={files}
      truncated={vault.truncated}
      filter={filter}
      onFilter={setFilter}
      tree={tree}
      openFolders={openFolders}
      onToggleFolder={toggleFolder}
      selectedPath={path}
      dirtyPath={dirty ? (editor?.path ?? null) : null}
      onSelect={(next) => leave({ kind: 'open', path: next })}
      {...(tabbed ? { onOpenInNewTab: (next: string) => openInNewTab(next) } : {})}
      onCreate={() => createNote(inboxNote(files ?? []))}
      canCreate={live && renameRequest === null}
      creating={fresh !== null && saving}
      filterRef={filterRef}
      sidebarCollapsed={sidebarCollapsed}
      {...(onToggleSidebar === undefined ? {} : { onToggleSidebar })}
      variant={dock !== undefined ? 'dock' : sidebarSlot === undefined ? 'page' : 'sidebar'}
    />
  )

  const showSidebarToggle = dock === undefined && sidebarSlot !== undefined && sidebarCollapsed && onToggleSidebar !== undefined

  const document = path === null ? (
    <EmptyStage listed={files !== null} docked={dock !== undefined} yieldsNarrow={dock === undefined && sidebarSlot === undefined} canCreate={live} onCreate={() => createNote(inboxNote(files ?? []))} />
  ) : (
    <div
      className={`relative grid min-h-0 min-w-0 ${dock === undefined ? 'max-[760px]:absolute max-[760px]:inset-0 max-[760px]:z-[8]' : ''}`}
    >
      <NoteDocument
        {...documentProps}
        onFollowNote={followNote}
        linkError={linkError}
        chrome={dock === undefined ? 'page' : 'panel'}
        clearsSidebarToggle={showSidebarToggle}
        onBack={() => leave({ kind: 'close' })}
      />
    </div>
  )

  if (dock === undefined && sidebarSlot !== undefined) {
    // Until the sidebar has mounted its slot the tree simply waits; the document does not.
    // With the sidebar away the tree goes with it, so its way back sits where Work's does.
    return (
      <div ref={stageRef} className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)]">
        {sidebarSlot === null ? null : createPortal(rail, sidebarSlot)}
        {noteTabStrip}
        {!showSidebarToggle || onToggleSidebar === undefined ? null : (
          <IconButton
            className="absolute top-[var(--titlebar-row-pad)] left-[calc(1rem+var(--titlebar-inset))] z-[9]"
            icon={SidebarLeftIcon}
            iconSize={17}
            label="Show sidebar"
            title="Show sidebar (⌘S)"
            aria-expanded={false}
            onClick={onToggleSidebar}
          />
        )}
        {document}
      </div>
    )
  }

  if (dock === undefined) {
    return (
      <div className="relative grid min-h-0 min-w-0 grid-cols-[260px_minmax(0,1fr)] max-[760px]:grid-cols-[minmax(0,1fr)]">
        {rail}
        {document}
      </div>
    )
  }

  const revealed = dock.revealed !== false
  // The quote toolbar portals out of the card, so it stays outside the held content
  // and leaves with the close instead of floating, clickable, over the slide.
  return (
    <>
      <DockPanelAside
        revealed={revealed}
        data-knowledge-panel={memoryKey}
        style={{ '--knowledge-width': `${dock.width}px`, '--knowledge-tree-width': `${FILES_TREE_WIDTH}px` } as CSSProperties}
        data-open={dock.overlay ? dock.revealed : undefined}
        className={`grid min-h-0 grid-rows-[auto_minmax(0,1fr)] ease-arrive ${DOCK_PANEL_SHELL} ${dockPanelLayoutClass(
          'w-[calc(var(--knowledge-width)-8px)]',
          dock.expanded,
          dock.overlay,
          'max-w-[max(calc(100%-375px),348px)]',
        )}`}
      >
        {dock.expanded ? null : (
          <div
            {...dock.resizeProps}
            className="group absolute inset-y-0 left-[-4px] z-10 w-2 touch-none cursor-col-resize outline-none"
          >
            <span
              className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${
                dock.resizing
                  ? 'bg-primary'
                  : 'bg-transparent group-hover:bg-muted group-focus-visible:bg-primary group-active:bg-primary'
              }`}
            />
          </div>
        )}

        <div className="min-w-0 border-b border-line">
          <div role="toolbar" aria-label="Knowledge actions" className="flex min-h-11 min-w-0 items-center gap-1 px-2 py-1">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {path === null ? null : (
                <IconButton
                  icon={SidebarLeftIcon}
                  label={showTree ? 'Hide note tree' : 'Show note tree'}
                  aria-pressed={showTree}
                  selected={showTree}
                  onClick={() => compact ? setCompactTree((current) => !current) : setTreeHidden(!treeHidden)}
                />
              )}
              {tabStrip}
            </div>
            <div className="flex flex-none items-center gap-1">
              {editor === null ? null : (
                <>
                  <span role="status" className="flex-none px-1 text-meta text-muted" title="Changes save automatically.">
                    {conflict !== null || rejected !== null ? 'Not saved' : !live ? 'Paused' : saving ? 'Saving…' : dirty ? 'Unsaved' : fresh !== null ? 'New note' : 'Saved'}
                  </span>
                </>
              )}
              <IconButton
                icon={dock.expanded ? ArrowShrink01Icon : ArrowExpand01Icon}
                label={dock.expanded ? 'Collapse knowledge panel' : 'Expand knowledge panel'}
                aria-expanded={dock.expanded}
                onClick={dock.onToggleExpanded}
              />
              <IconButton
                icon={Cancel01Icon}
                label="Close knowledge"
                onClick={() => path === null ? dock.onClosePanel() : leave({ kind: 'closePanel' })}
              />
            </div>
          </div>
          {/* The tabs name the note; a rename asked for from the tree is typed here. */}
          {renameProps.editing ? <div className="px-3 pb-2 text-label text-text"><NoteName key={path} {...renameProps} /></div> : null}
        </div>

        <div className={`grid min-h-0 ${splitColumns ? SPLIT_COLUMNS : 'grid-cols-1'}`}>
          <div className={`${showTree ? 'grid' : 'hidden'} min-h-0 min-w-0 overflow-hidden border-r border-line`}>
            {rail}
          </div>
          <div className={`${compact && showTree ? 'hidden' : 'grid'} relative min-h-0 min-w-0`}>
            {document}
          </div>
        </div>
      </DockPanelAside>
    </>
  )
}

/** `yieldsNarrow`: the page's own tree takes the whole width below 760px, so this steps aside. */
function EmptyStage({ listed, docked, yieldsNarrow, canCreate, onCreate }: { listed: boolean; docked: boolean; yieldsNarrow: boolean; canCreate: boolean; onCreate: () => void }) {
  return (
    <div role={docked ? 'region' : 'main'} aria-label="Knowledge" className={`grid min-h-0 place-items-center px-6 ${yieldsNarrow ? 'max-[760px]:hidden' : ''}`}>
      <div className={`text-center ${docked ? '' : 'max-w-[46ch]'}`}>
        <h1 className="m-0 font-display text-xl font-medium text-text">{listed ? 'No note open' : 'Reading the vault…'}</h1>
        <p className="mt-2 mb-5 text-[13px] leading-relaxed text-muted">Open a note from the sidebar, or capture something new in Inbox.</p>
        {listed ? <Button variant="primary" size="compact" disabled={!canCreate} onClick={onCreate}>New note</Button> : null}
        <p className="mt-5 mb-0 text-[12px] leading-[2] text-muted">
          <Key>/</Key> to filter notes, <Key>⌘S</Key> to save now
        </p>
      </div>
    </div>
  )
}

const Key = ({ children }: { children: ReactNode }) => (
  <kbd className="rounded-sm border border-line px-1 py-px font-mono text-meta text-muted">{children}</kbd>
)

function editBlocked(status: ConnectionStatus, result: string | undefined): string {
  if (status !== 'live') return 'Disconnected, editing is paused.'
  if (result === undefined || result === 'ready') return ''
  return 'This note cannot be edited here.'
}

function inboxNote(files: readonly string[]): string {
  const taken = new Set(files.map((file) => file.toLowerCase()))
  const at = (suffix: string) => `${INBOX}/untitled${suffix}.md`
  if (!taken.has(at('').toLowerCase())) return at('')
  for (let n = 2; n < 1_000; n += 1) {
    const candidate = at(`-${n}`)
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return at('')
}

const typing = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
