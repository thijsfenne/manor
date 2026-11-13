import { deleteKnowledgeDrafts, editorMemory, moveKnowledgeDrafts, renameKnowledgeDrafts } from '../src/components/knowledge/knowledgeDrafts'
import { describe, expect, it } from 'vitest'
import { buildNoteIndex, resolveNote } from '@manor/client-runtime/vault-notes'
import {
  askVaultFile,
  askVaultWrite,
  clearVaultWrite,
  closeVaultNote,
  emptyWorkspace,
  reduce,
} from '../src/state'
import { buildTree, folderPaths } from '../src/components/ui/FileTree'
import { filterNotes } from '../src/components/knowledge/NoteRail'

describe('vault state', () => {
  it('drops a deleted folder from every tree and forgets reads and saves inside it', () => {
    let state = reduce(emptyWorkspace, { type: 'vault_files', files: ['a.md', 'research/b.md', 'research/wiki/c.md', 'researcher.md'], folders: ['research', 'research/wiki'], previews: { 'research/b.md': 'b', 'a.md': 'a' }, truncated: false })
    state = askVaultWrite(askVaultFile(state, 'research/wiki/c.md'), 'research/wiki/c.md')
    const other = reduce(state, { type: 'vault_deleted', requestId: 'd1', path: 'research', result: { status: 'deleted', kind: 'folder', trashPath: '/t/x/research' } })
    expect(other.vault).toMatchObject({ files: ['a.md', 'researcher.md'], folders: [], previews: { 'a.md': 'a' }, note: null, write: null, deleted: { requestId: 'd1', path: 'research', kind: 'folder' } })
    expect(other.vault.deletion).toBeUndefined()
    const refused = reduce(state, { type: 'vault_deleted', requestId: 'd2', path: 'a.md', result: { status: 'rejected', message: 'no' } })
    expect(refused).toBe(state)
  })

  it('forgets an off-screen new draft inside a deleted folder but keeps edits to a saved note', () => {
    editorMemory.clear()
    editorMemory.set('chat-1', { editor: { path: 'research/new.md', text: 'typed', disk: null, base: null }, fresh: 'research/new.md', renameRequest: null })
    editorMemory.set('chat-2', { editor: { path: 'research/old.md', text: 'edited', disk: 'old', base: 'r1' }, fresh: null, renameRequest: null })
    editorMemory.set('chat-3', { editor: { path: 'research/clean.md', text: 'same', disk: 'same', base: 'r2' }, fresh: null, renameRequest: null })
    deleteKnowledgeDrafts('research')
    expect([...editorMemory.keys()]).toEqual(['chat-2'])
    editorMemory.clear()
  })

  it('starts not knowing whether there is a vault, which is not the same as none', () => {
    expect(emptyWorkspace.vault.status).toBe('unknown')
    expect(reduce(emptyWorkspace, { type: 'vault_status', available: false, name: null, root: null }).vault.status).toBe('none')
    const ready = reduce(emptyWorkspace, { type: 'vault_status', available: true, name: 'Notes', root: '/vault' })
    expect(ready.vault).toMatchObject({ status: 'ready', name: 'Notes' })
  })

  it('keeps the same listing identity when a re-list changed nothing', () => {
    const listed = reduce(emptyWorkspace, { type: 'vault_files', files: ['a.md', 'b.md'], truncated: false })
    expect(listed.vault.files).toEqual(['a.md', 'b.md'])
    expect(reduce(listed, { type: 'vault_files', files: ['a.md', 'b.md'], truncated: false })).toBe(listed)
  })

  it('drops a read that answers the note the reader has already left', () => {
    const asked = askVaultFile(emptyWorkspace, 'b.md')
    const stale = reduce(asked, { type: 'vault_file', path: 'a.md', result: { status: 'ready', content: 'old' } })
    expect(stale).toBe(asked)
    const landed = reduce(asked, {
      type: 'vault_file',
      path: 'b.md',
      result: { status: 'ready', content: 'new', revision: 'r1' },
    })
    expect(landed.vault.note).toEqual({ path: 'b.md', result: { status: 'ready', content: 'new', revision: 'r1' } })
  })

  it('opening a note drops the previous save answer, which was about another note', () => {
    const conflicted = reduce(askVaultWrite(askVaultFile(emptyWorkspace, 'a.md'), 'a.md'), {
      type: 'vault_write',
      path: 'a.md',
      result: { status: 'stale', revision: 'r2', content: 'theirs' },
    })
    expect(conflicted.vault.write?.result?.status).toBe('stale')
    expect(askVaultFile(conflicted, 'b.md').vault.write).toBeNull()
  })

  it('marks a save pending and settles it, and can be told to forget the answer', () => {
    const pending = askVaultWrite(askVaultFile(emptyWorkspace, 'a.md'), 'a.md')
    expect(pending.vault.write).toEqual({ path: 'a.md', result: null })
    const saved = reduce(pending, { type: 'vault_write', path: 'a.md', result: { status: 'saved', revision: 'r9' } })
    expect(saved.vault.write?.result).toEqual({ status: 'saved', revision: 'r9' })
    expect(clearVaultWrite(saved).vault.write).toBeNull()
  })

  it('closing a note leaves the listing standing', () => {
    const open = askVaultFile(reduce(emptyWorkspace, { type: 'vault_files', files: ['a.md'], truncated: false }), 'a.md')
    const closed = closeVaultNote(open)
    expect(closed.vault.note).toBeNull()
    expect(closed.vault.files).toEqual(['a.md'])
  })
})

describe('the rail tree', () => {
  const files = ['meetings/2026-05-28-block.md', 'people/robin.md', 'people/levi.md', 'index.md']

  it('puts folders before files and sorts each level', () => {
    const tree = buildTree(files)
    expect(tree.map((node) => node.name)).toEqual(['meetings', 'people', 'index.md'])
    expect(tree[1]?.children.map((node) => node.name)).toEqual(['levi.md', 'robin.md'])
    expect(folderPaths(tree)).toEqual(['meetings', 'people'])
  })

  it('filters on the whole path, and opens every folder that survived', () => {
    const { tree, expandAll } = filterNotes(files, 'people/')
    expect(tree.map((node) => node.name)).toEqual(['people'])
    expect(expandAll).toEqual(['people'])
  })

  it('matches a folder name as readily as a note name, and can match nothing', () => {
    expect(filterNotes(files, 'MEETINGS').tree).toHaveLength(1)
    expect(filterNotes(files, 'nothing here').tree).toHaveLength(0)
  })

  it('leaves the hand-built open folders alone when no filter is on', () => {
    expect(filterNotes(files, '   ').expandAll).toEqual([])
  })
})


describe('Knowledge folders and previews', () => {
  it('keeps an empty folder visible in both the full and filtered tree', () => {
    const { tree } = filterNotes([], '', ['projects/Empty'])
    expect(folderPaths(tree)).toEqual(['projects', 'projects/Empty'])
    expect(tree[0]?.children[0]).toMatchObject({ file: false, name: 'Empty', children: [] })
    expect(folderPaths(filterNotes([], 'Empty', ['projects/Empty']).tree)).toEqual(['projects', 'projects/Empty'])
  })

  it('updates excerpts after save and ignores dictionary insertion order when re-listing', () => {
    const listed = reduce(emptyWorkspace, { type: 'vault_files', files: ['a.md', 'b.md'], previews: { 'a.md': 'A', 'b.md': 'B' }, folders: ['Empty'], truncated: false })
    expect(reduce(listed, { type: 'vault_files', files: ['a.md', 'b.md'], previews: { 'b.md': 'B', 'a.md': 'A' }, folders: ['Empty'], truncated: false })).toBe(listed)
    const saved = reduce(askVaultWrite(listed, 'a.md'), { type: 'vault_write', path: 'a.md', result: { status: 'saved', revision: 'r1' }, preview: 'Edited' })
    expect(saved.vault.previews?.['a.md']).toBe('Edited')
  })

  it('ignores a folder response for a different pending path', () => {
    const pending = { ...emptyWorkspace, vault: { ...emptyWorkspace.vault, folderWrite: { path: 'current', result: null } } }
    expect(reduce(pending, { type: 'vault_folder_created', path: 'old', result: { status: 'created' } })).toBe(pending)
    expect(reduce(pending, { type: 'vault_folder_created', path: 'current', result: { status: 'created' } }).vault.folderWrite?.result?.status).toBe('created')
  })
})


describe('Knowledge rename state', () => {
  it('remaps remembered notes in every chat without changing unsaved text or revisions', () => {
    editorMemory.clear()
    editorMemory.set('chat-a', { editor: { path: 'a.md', text: 'Unsaved A', disk: 'Original', base: 'r1' }, fresh: null, renameRequest: null })
    editorMemory.set('chat-b', { editor: { path: 'a.md', text: 'Original', disk: 'Original', base: 'r1' }, fresh: null, renameRequest: null })
    renameKnowledgeDrafts('a.md', 'b.md')
    expect(editorMemory.get('chat-a')?.editor).toEqual({ path: 'b.md', text: 'Unsaved A', disk: 'Original', base: 'r1' })
    expect(editorMemory.get('chat-b')?.editor.path).toBe('b.md')
    editorMemory.clear()
  })

  it('ignores old replies and carries the note, excerpt and selection to the new path', () => {
    const listed = reduce(emptyWorkspace, { type: 'vault_files', files: ['a.md'], previews: { 'a.md': 'Excerpt' }, truncated: false })
    const opened = askVaultWrite(askVaultFile(listed, 'a.md'), 'a.md')
    const pending = { ...opened, vault: { ...opened.vault, rename: { requestId: 'current', path: 'a.md', newPath: 'b.md', result: null } } }
    const answer = { type: 'vault_renamed' as const, requestId: 'old', path: 'a.md', newPath: 'b.md', result: { status: 'renamed' as const, revision: 'r1' } }
    expect(reduce(pending, answer)).toBe(pending)
    const renamed = reduce(pending, { ...answer, requestId: 'current' }).vault
    expect(renamed.files).toEqual(['b.md'])
    expect(renamed.previews).toEqual({ 'b.md': 'Excerpt' })
    expect(renamed.note?.path).toBe('b.md')
    expect(renamed.write).toBeNull()
    const rejected = reduce(pending, { ...answer, requestId: 'current', result: { status: 'rejected', message: 'Already exists' } }).vault
    expect(rejected.files).toEqual(['a.md'])
    expect(rejected.note?.path).toBe('a.md')
  })
})

describe('Knowledge move state', () => {
  it('carries every path under a moved folder on every client, and forgets a save in flight there', () => {
    let state = reduce(emptyWorkspace, { type: 'vault_files', files: ['a.md', 'research/b.md', 'research/wiki/c.md', 'researcher.md'], folders: ['archive', 'research', 'research/wiki'], previews: { 'research/wiki/c.md': 'c' }, truncated: false })
    state = askVaultWrite(askVaultFile(state, 'research/wiki/c.md'), 'research/wiki/c.md')
    const moved = reduce(state, { type: 'vault_moved', requestId: 'm1', path: 'research', result: { status: 'moved', kind: 'folder', newPath: 'archive/research' } }).vault
    expect(moved.files).toEqual(['a.md', 'archive/research/b.md', 'archive/research/wiki/c.md', 'researcher.md'])
    expect(moved.folders).toEqual(['archive', 'archive/research', 'archive/research/wiki'])
    expect(moved.previews).toEqual({ 'archive/research/wiki/c.md': 'c' })
    expect(moved.note?.path).toBe('archive/research/wiki/c.md')
    expect(moved.write).toBeNull()
    expect(moved.moved).toEqual({ requestId: 'm1', path: 'research', newPath: 'archive/research', kind: 'folder' })
  })

  it('lets a read sent before a move or rename finish for the note at its new path, so it never stays loading', () => {
    const listed = reduce(emptyWorkspace, { type: 'vault_files', files: ['research/c.md'], folders: ['archive', 'research'], truncated: false })
    const reading = askVaultFile(listed, 'research/c.md')
    const moved = reduce(reading, { type: 'vault_moved', requestId: 'm1', path: 'research', result: { status: 'moved', kind: 'folder', newPath: 'archive/research' } })
    expect(moved.vault.note).toEqual({ path: 'archive/research/c.md', result: null, requested: 'research/c.md' })
    const ready = { status: 'ready' as const, content: '# c', revision: 'r1' }
    expect(reduce(moved, { type: 'vault_file', path: 'research/c.md', result: ready }).vault.note).toEqual({ path: 'archive/research/c.md', result: ready })
    // The read ran after the move and found nothing: drop it so the panel reads the new path.
    expect(reduce(moved, { type: 'vault_file', path: 'research/c.md', result: { status: 'unavailable', message: 'gone' } }).vault.note).toBeNull()
    // A newer read for the new path owns the note; the old reply no longer answers.
    const reread = askVaultFile(moved, 'archive/research/c.md')
    expect(reduce(reread, { type: 'vault_file', path: 'research/c.md', result: ready })).toBe(reread)

    const renaming = { ...reading, vault: { ...reading.vault, rename: { requestId: 'r1', path: 'research/c.md', newPath: 'research/d.md', result: null } } }
    const renamed = reduce(renaming, { type: 'vault_renamed', requestId: 'r1', path: 'research/c.md', newPath: 'research/d.md', result: { status: 'renamed', revision: 'r1' } })
    expect(reduce(renamed, { type: 'vault_file', path: 'research/c.md', result: ready }).vault.note).toEqual({ path: 'research/d.md', result: ready })
  })

  it('resolves a bare wikilink to a note moved to the top level, because the shallowest path wins', () => {
    const listed = reduce(emptyWorkspace, { type: 'vault_files', files: ['a/b/Plan.md', 'c/d/Plan.md'], folders: ['a', 'a/b', 'c', 'c/d'], truncated: false })
    const moved = reduce(listed, { type: 'vault_moved', requestId: 'm1', path: 'c/d/Plan.md', result: { status: 'moved', kind: 'note', newPath: 'Plan.md' } })
    expect(moved.vault.files).toEqual(['a/b/Plan.md', 'Plan.md'])
    expect(resolveNote(buildNoteIndex(moved.vault.files ?? []), 'Plan')).toBe('Plan.md')
  })

  it('puts a refused drop in the notice, keeps a dialog refusal out of it, and ignores others', () => {
    const listed = reduce(emptyWorkspace, { type: 'vault_files', files: ['a.md'], folders: ['x'], truncated: false })
    const asked = (notify: boolean) => ({ ...listed, vault: { ...listed.vault, move: { requestId: 'm1', path: 'a.md', folder: 'x', notify, result: null } } })
    const refusal = { type: 'vault_moved' as const, requestId: 'm1', path: 'a.md', result: { status: 'rejected' as const, message: 'Taken' } }
    expect(reduce(asked(true), refusal).notice).toEqual({ kind: 'error', text: 'Taken' })
    const dialog = reduce(asked(false), refusal)
    expect(dialog.notice).toBeNull()
    expect(dialog.vault.move?.result).toEqual(refusal.result)
    expect(reduce(listed, refusal)).toBe(listed)
    const same = reduce(asked(true), { ...refusal, result: { status: 'moved', kind: 'note', newPath: 'a.md' } })
    expect(same.vault.files).toEqual(['a.md'])
    expect(same.vault.moved).toBeUndefined()
  })

  it('moves off-screen drafts under a moved folder with their text', () => {
    editorMemory.clear()
    editorMemory.set('chat-a', { editor: { path: 'research/a.md', text: 'Unsaved', disk: 'Original', base: 'r1' }, fresh: null, renameRequest: null })
    editorMemory.set('chat-b', { editor: { path: 'researcher.md', text: 'x', disk: 'x', base: 'r2' }, fresh: null, renameRequest: null })
    moveKnowledgeDrafts('research', 'archive/research')
    expect(editorMemory.get('chat-a')?.editor).toEqual({ path: 'archive/research/a.md', text: 'Unsaved', disk: 'Original', base: 'r1' })
    expect(editorMemory.get('chat-b')?.editor.path).toBe('researcher.md')
    editorMemory.clear()
  })
})
