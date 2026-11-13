import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { VaultState } from '../src/state'
import { KnowledgePanel, NOTE_AUTOSAVE_MS } from '../src/components/knowledge/KnowledgePanel'
import { NoteDocument } from '../src/components/knowledge/NoteDocument'

vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }))
vi.mock('../src/components/knowledge/NoteRail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/knowledge/NoteRail')>()),
  NoteRail: () => null,
}))
vi.mock('../src/components/knowledge/NoteDocument', () => ({ NoteDocument: () => null }))

beforeEach(() => {
  vi.useFakeTimers()
  // A hidden page, so the open-note refresh stays quiet and only the autosave runs.
  vi.stubGlobal('window', {
    document: { visibilityState: 'hidden', addEventListener: vi.fn(), removeEventListener: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const base: VaultState = {
  status: 'ready',
  name: 'Notes',
  root: null,
  files: ['a.md', 'b.md'],
  truncated: false,
  note: { path: 'a.md', result: { status: 'ready', content: 'one', revision: 'r1' } as never },
  write: null,
}

it('applies the open note\'s save result when another note is deleted mid-save', () => {
  const onSave = vi.fn(() => true)
  const onOpen = vi.fn(() => true)
  const panel = (vault: VaultState) => (
    <KnowledgePanel
      vault={vault}
      status="live"
      onList={() => undefined}
      onCreateFolder={() => true}
      onDelete={() => true}
      onRename={() => true}
      onMove={() => true}
      onOpen={onOpen}
      onSave={onSave}
      onClearWrite={() => undefined}
      onEditNote={() => true}
      onForgetNoteEdit={() => undefined}
      noteAiModel="claude-sonnet-5-5"
      onClose={() => undefined}
    />
  )
  let root!: ReactTestRenderer
  act(() => { root = create(panel(base)) })
  const doc = () => root.root.findByType(NoteDocument).props

  act(() => doc().onChange('one two'))
  act(() => { vi.advanceTimersByTime(NOTE_AUTOSAVE_MS) })
  expect(onSave).toHaveBeenCalledWith('a.md', 'one two', 'r1')

  const saving = { ...base, write: { path: 'a.md', result: null } }
  act(() => root.update(panel(saving)))
  act(() => root.update(panel({ ...saving, deleted: { requestId: 'd1', path: 'b.md', kind: 'note' } })))
  onOpen.mockClear()
  act(() => root.update(panel({ ...saving, deleted: { requestId: 'd1', path: 'b.md', kind: 'note' }, write: { path: 'a.md', result: { status: 'saved', revision: 'r2' } } })))

  expect(doc().editor).toMatchObject({ path: 'a.md', text: 'one two', disk: 'one two', base: 'r2' })
  expect(onOpen).toHaveBeenCalledWith('a.md')
})

it('leaves Mod-Shift-S to the note editor (strikethrough) and saves only on Mod-S', () => {
  const onSave = vi.fn(() => true)
  let root!: ReactTestRenderer
  act(() => {
    root = create(
      <KnowledgePanel
        vault={base}
        status="live"
        onList={() => undefined}
        onCreateFolder={() => true}
        onDelete={() => true}
        onRename={() => true}
        onMove={() => true}
        onOpen={() => true}
        onSave={onSave}
        onClearWrite={() => undefined}
        onEditNote={() => true}
        onForgetNoteEdit={() => undefined}
        noteAiModel="claude-sonnet-5-5"
        onClose={() => undefined}
      />,
    )
  })
  act(() => root.root.findByType(NoteDocument).props.onChange('one two'))
  const listeners = vi.mocked(window.addEventListener).mock.calls.filter(([type]) => type === 'keydown')
  const press = (shiftKey: boolean) => {
    const event = { key: shiftKey ? 'S' : 's', metaKey: true, ctrlKey: false, shiftKey, target: null, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    act(() => { for (const [, listener] of listeners) (listener as (event: unknown) => void)(event) })
    return event
  }
  const shifted = press(true)
  expect(shifted.preventDefault).not.toHaveBeenCalled()
  expect(shifted.stopPropagation).not.toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
  press(false)
  expect(onSave).toHaveBeenCalledWith('a.md', 'one two', 'r1')
})

it('follows a note moved to another folder with its unsaved text, and saves it there', () => {
  const onSave = vi.fn(() => true)
  const panel = (vault: VaultState) => (
    <KnowledgePanel
      vault={vault}
      status="live"
      onList={() => undefined}
      onCreateFolder={() => true}
      onDelete={() => true}
      onRename={() => true}
      onMove={() => true}
      onOpen={() => true}
      onSave={onSave}
      onClearWrite={() => undefined}
      onEditNote={() => true}
      onForgetNoteEdit={() => undefined}
      noteAiModel="claude-sonnet-5-5"
      onClose={() => undefined}
    />
  )
  let root!: ReactTestRenderer
  act(() => { root = create(panel(base)) })
  const doc = () => root.root.findByType(NoteDocument).props
  const opened = doc().editor.document
  act(() => doc().onChange('one two'))
  // A save of the old path was in flight when another client moved the note.
  act(() => { vi.advanceTimersByTime(NOTE_AUTOSAVE_MS) })
  expect(onSave).toHaveBeenLastCalledWith('a.md', 'one two', 'r1')
  act(() => root.update(panel({ ...base, write: { path: 'a.md', result: null } })))
  // The reducer forgot that save and moved the read with the note.
  const moved: VaultState = { ...base, files: ['b.md', 'notes/a.md'], folders: ['notes'], note: { ...base.note!, path: 'notes/a.md' }, write: null, moved: { requestId: 'm1', path: 'a.md', newPath: 'notes/a.md', kind: 'note' } }
  act(() => root.update(panel(moved)))
  expect(doc().editor).toMatchObject({ path: 'notes/a.md', text: 'one two', base: 'r1', document: opened })
  expect(doc().path).toBe('notes/a.md')
  act(() => { vi.advanceTimersByTime(NOTE_AUTOSAVE_MS) })
  expect(onSave).toHaveBeenLastCalledWith('notes/a.md', 'one two', 'r1')
})
