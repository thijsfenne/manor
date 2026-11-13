import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chat } from '@manor/contracts'
import { insideVaultEntry, movedVaultPath } from '@manor/client-runtime/state'
import { deleteKnowledgeDrafts, moveKnowledgeDrafts, renameKnowledgeDrafts } from './components/knowledge/knowledgeDrafts'
import type { DiffScope } from './components/session/DiffPanel'
import type { useRightPanel } from './useRightPanel'
import type { Manor } from './useWorkspace'

/**
 * What each chat's docked panels point at: the file in Files, the note in Knowledge and
 * the scope of the diff pane. Held per chat above the panels, so they come back as they
 * were when a chat returns to the stage or moves to the other pane.
 */
export function usePanelSelections(manor: Manor, rightPanel: ReturnType<typeof useRightPanel>) {
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string | null>>({})
  const [selectedNotes, setSelectedNotes] = useState<Record<string, string | null>>({})
  /** What each chat's diff pane shows, and the last turn opened in it from a card. */
  const [diffViews, setDiffViews] = useState<Record<string, DiffScope>>({})

  // A note renamed in Knowledge stays selected under its new path.
  const rename = manor.workspace.vault.rename
  useEffect(() => {
    if (rename?.result?.status !== 'renamed') return
    renameKnowledgeDrafts(rename.path, rename.newPath)
    setSelectedNotes((current) => Object.fromEntries(Object.entries(current).map(([key, path]) => [key, path === rename.path ? rename.newPath : path])))
  }, [rename])

  // A moved note, or a note inside a moved folder, stays selected under its new path.
  const moved = manor.workspace.vault.moved
  useEffect(() => {
    if (moved === undefined) return
    moveKnowledgeDrafts(moved.path, moved.newPath)
    setSelectedNotes((current) => Object.fromEntries(Object.entries(current).map(([key, path]) => [key, path === null ? null : movedVaultPath(path, moved.path, moved.newPath)])))
  }, [moved])

  // A deleted note, or a note inside a deleted folder, is no longer any chat's selection.
  const deleted = manor.workspace.vault.deleted
  useEffect(() => {
    if (deleted === undefined) return
    deleteKnowledgeDrafts(deleted.path)
    setSelectedNotes((current) => Object.fromEntries(Object.entries(current).map(([key, path]) => [key, path !== null && insideVaultEntry(path, deleted.path) ? null : path])))
  }, [deleted])

  const setDiffScope = useCallback(
    (chatId: string, scope: DiffScope) => setDiffViews((current) => ({ ...current, [chatId]: scope })),
    [],
  )

  /** A path in a reply or a card: the chat's Files panel, on that file once it is read. */
  const openFileFor = useCallback((chat: Chat, path: string) => {
    if (chat.projectId === null) return
    rightPanel.showFor(chat.id, 'files')
    if (manor.readRepoFile(chat.projectId, path, chat.id)) {
      setSelectedFiles((current) => ({ ...current, [chat.id]: path }))
    }
  }, [manor.readRepoFile, rightPanel.showFor])

  /**
   * A changed-files card's Review: that turn in the diff pane, beside whatever is open.
   * One stable function per chat, so a re-render above does not redraw every card.
   */
  const reviewTurn = useRef((_chatId: string, _turnId: string) => {})
  reviewTurn.current = (chatId, turnId) => {
    setDiffScope(chatId, { kind: 'turn', turnId })
    rightPanel.showFor(chatId, 'diff')
  }
  const reviewers = useRef(new Map<string, (turnId: string) => void>())
  const reviewerFor = (chatId: string) => {
    let reviewer = reviewers.current.get(chatId)
    if (reviewer === undefined) {
      reviewer = (turnId) => reviewTurn.current(chatId, turnId)
      reviewers.current.set(chatId, reviewer)
    }
    return reviewer
  }

  return { selectedFiles, setSelectedFiles, selectedNotes, setSelectedNotes, diffViews, setDiffScope, openFileFor, reviewerFor }
}
