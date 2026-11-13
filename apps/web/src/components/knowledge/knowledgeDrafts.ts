import { insideVaultEntry, movedVaultPath } from '@manor/client-runtime/state'
import type { EditorState } from './NoteDocument'

export type RenameRequest = { requestId: string; path: string; newPath: string; phase: 'waiting' | 'sent' | 'retry'; baseRevision?: string }

/** Tab-lifetime drafts survive switching rail destinations and chats. */
export const editorMemory = new Map<string, { editor: EditorState; fresh: string | null; renameRequest: RenameRequest | null }>()

export function renameKnowledgeDrafts(path: string, newPath: string) {
  for (const [key, draft] of editorMemory) {
    if (draft.editor.path !== path) continue
    editorMemory.set(key, { ...draft, editor: { ...draft.editor, path: newPath }, fresh: draft.fresh === path ? newPath : draft.fresh })
  }
}

/** Drafts of panels that are not on screen follow a moved note, or a note inside a moved folder. */
export function moveKnowledgeDrafts(path: string, newPath: string) {
  const swap = (target: string) => movedVaultPath(target, path, newPath)
  for (const [key, draft] of editorMemory) {
    if (!insideVaultEntry(draft.editor.path, path)) continue
    editorMemory.set(key, { ...draft, editor: { ...draft.editor, path: swap(draft.editor.path) }, fresh: draft.fresh === null ? null : swap(draft.fresh) })
  }
}

/**
 * Forgets the drafts of panels that are not on screen for a deleted note or folder. A
 * draft with unsaved edits to a saved note stays: its next save is refused as missing and
 * says so. A new note that was never saved is dropped, because its save is a create and
 * would put the deleted note back.
 */
export function deleteKnowledgeDrafts(path: string) {
  for (const [key, draft] of editorMemory) {
    if (!insideVaultEntry(draft.editor.path, path)) continue
    const unsaved = draft.editor.text !== (draft.editor.disk ?? '')
    if (draft.fresh !== null || !unsaved) editorMemory.delete(key)
  }
}
