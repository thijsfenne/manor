import type { FileWriteResult } from '@manor/contracts'
import { useState } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { EditorState } from '../src/components/knowledge/NoteDocument'
import { useNoteAi, type NoteAi } from '../src/components/knowledge/useNoteAi'
import type { VaultNoteEditResult } from '@manor/client-runtime/state'

const NOTE = 'We hebben eigenlijk veel input gekregen.\n\nDaarna gaan we schetsen.\n'
const SELECTION = { from: NOTE.indexOf('eigenlijk'), to: NOTE.indexOf('eigenlijk') + 'eigenlijk veel input'.length }

/** The hook with the panel's side of it: the editor state, the save path and the answers. */
function mount(note = NOTE) {
  const onAsk = vi.fn((_id: string, _note: string, _selection: { from: number; to: number } | null, _instruction: string) => true)
  const onSave = vi.fn(() => true)
  const onSaved = vi.fn()
  const onForget = vi.fn()
  const onClearWrite = vi.fn()
  const seen: { ai: NoteAi; editor: EditorState | null } = { ai: undefined as never, editor: null }
  let props: { results: Record<string, VaultNoteEditResult>; writeResult: FileWriteResult | null; saving: boolean; live: boolean } = { results: {}, writeResult: null, saving: false, live: true }

  function Harness({ results, writeResult, saving, live }: typeof props) {
    const [editor, setEditor] = useState<EditorState | null>({ path: 'a.md', text: note, disk: note, base: 'r1', document: 1 })
    seen.editor = editor
    seen.ai = useNoteAi({
      editor, setEditor, live, saving, refused: writeResult?.status === 'stale' || writeResult?.status === 'rejected',
      writeResult, results, model: 'Sonnet 5.5', onAsk, onForget, onSave, onClearWrite, onSaved,
    })
    return null
  }

  const renderer = create(<Harness {...props} />)
  const set = (next: Partial<typeof props>) => {
    props = { ...props, ...next }
    act(() => renderer.update(<Harness {...props} />))
  }
  const answer = (text: string) => set({ results: { [String(onAsk.mock.calls.at(-1)?.[0])]: { status: 'ready', text } } })
  return { seen, set, answer, onAsk, onSave, onSaved, onForget, onClearWrite, live: (live: boolean) => { props = { ...props, live }; act(() => renderer.update(<Harness {...props} />)) } }
}

it('turns a selection answer into one change and writes only on Accept, against the revision it read', () => {
  const { seen, set, answer, onAsk, onSave, onSaved } = mount()
  act(() => seen.ai.ask(SELECTION, 'Make it shorter'))
  expect(onAsk).toHaveBeenCalledWith(expect.any(String), NOTE, SELECTION, 'Make it shorter')
  expect(seen.ai.state).toMatchObject({ phase: 'working', scope: 'selection', ...SELECTION })

  answer('veel input')
  expect(seen.ai.state).toMatchObject({ phase: 'proposal', changes: [{ ...SELECTION, insert: 'veel input' }] })
  expect(onSave).not.toHaveBeenCalled()
  expect(seen.editor?.text).toBe(NOTE)

  const proposed = NOTE.replace('eigenlijk veel input', 'veel input')
  act(() => seen.ai.accept())
  expect(onSave).toHaveBeenCalledWith('a.md', proposed, 'r1')
  set({ saving: true })
  expect(seen.ai.canAccept).toBe(false)

  set({ saving: false, writeResult: { status: 'saved', revision: 'r2' } })
  expect(seen.ai.state.phase).toBe('applying')
  // The editor reports the changes are in the document.
  act(() => seen.ai.applied(proposed))
  expect(seen.ai.state.phase).toBe('idle')
  expect(seen.editor).toMatchObject({ text: proposed, disk: proposed, base: 'r2' })
  expect(onSaved).toHaveBeenCalledWith('a.md')
})

it('keeps the proposal and the note when the file changed on disk before Accept', () => {
  const { seen, set, answer, onSave } = mount()
  act(() => seen.ai.ask(null, 'Tighten'))
  answer(NOTE.replace('eigenlijk ', ''))
  expect(seen.ai.state).toMatchObject({ phase: 'proposal', scope: 'note' })
  const proposal = seen.ai.state

  act(() => seen.ai.accept())
  set({ writeResult: { status: 'stale', revision: 'r9', content: 'theirs' } })

  expect(seen.ai.state).toEqual({ ...proposal, accepting: false })
  expect(seen.ai.canAccept).toBe(false)
  expect(seen.editor).toMatchObject({ text: NOTE, disk: NOTE, base: 'r1' })
  // Refused once, not retried behind the user's back.
  act(() => seen.ai.accept())
  expect(onSave).toHaveBeenCalledTimes(1)
})

it('restores nothing on Reject because nothing was changed, and cancels a job that is stopped', () => {
  const { seen, answer, onForget, onSave } = mount()
  act(() => seen.ai.ask(SELECTION, 'x'))
  act(() => seen.ai.stop())
  expect(onForget).toHaveBeenLastCalledWith(expect.any(String), true)
  expect(seen.ai.state.phase).toBe('idle')

  act(() => seen.ai.ask(SELECTION, 'x'))
  answer('veel input')
  act(() => seen.ai.reject())
  expect(seen.ai.state.phase).toBe('idle')
  expect(seen.editor?.text).toBe(NOTE)
  expect(onSave).not.toHaveBeenCalled()
})

it('says so when the answer changes nothing or the job failed', () => {
  const { seen, set, answer, onAsk } = mount()
  act(() => seen.ai.ask(SELECTION, 'x'))
  answer('eigenlijk veel input')
  expect(seen.ai.state).toMatchObject({ phase: 'failed', message: 'The AI found nothing to change.' })

  act(() => seen.ai.ask(null, 'x'))
  set({ results: { [String(onAsk.mock.calls.at(-1)?.[0])]: { status: 'failed', message: 'provider unavailable' } } })
  expect(seen.ai.state).toMatchObject({ phase: 'failed', scope: 'note', message: 'provider unavailable' })
})

it('gives the proposal back when the answer to its save is lost, and leaves the retry to the revision check', () => {
  const { seen, set, answer, onSave } = mount()
  act(() => seen.ai.ask(SELECTION, 'x'))
  answer('veel input')
  act(() => seen.ai.accept())
  set({ saving: true })
  // Another dock's save took the write slot: no longer saving, and no answer for this note.
  set({ saving: false })
  expect(seen.ai.state).toMatchObject({ phase: 'proposal', accepting: false })
  expect(seen.ai.canAccept).toBe(true)
  act(() => seen.ai.accept())
  expect(onSave).toHaveBeenCalledTimes(2)
  expect(onSave).toHaveBeenLastCalledWith('a.md', NOTE.replace('eigenlijk veel input', 'veel input'), 'r1')
})

it('counts a note with Windows line endings the way the editor does', () => {
  const { seen, answer, onAsk, onSave } = mount(NOTE.replaceAll('\n', '\r\n'))
  // The editor's offsets: every line break is one character.
  act(() => seen.ai.ask(SELECTION, 'x'))
  expect(onAsk).toHaveBeenCalledWith(expect.any(String), NOTE, SELECTION, 'x')
  answer('veel input')
  act(() => seen.ai.accept())
  expect(onSave).toHaveBeenCalledWith('a.md', NOTE.replace('eigenlijk veel input', 'veel input'), 'r1')
})

it('keeps a proposal whose save is out through Esc, and frees it when the connection drops', () => {
  const { seen, set, answer, live, onClearWrite } = mount()
  act(() => seen.ai.ask(SELECTION, 'x'))
  answer('veel input')
  act(() => seen.ai.accept())
  set({ saving: true })
  // The save can still land, so Reject (Esc) leaves it alone.
  act(() => seen.ai.reject())
  expect(seen.ai.state).toMatchObject({ phase: 'proposal', accepting: true })

  live(false)
  expect(onClearWrite).toHaveBeenCalledTimes(1)
  expect(seen.ai.state).toMatchObject({ phase: 'proposal', accepting: false })
  // The panel's slot is retired, and the connection comes back.
  set({ saving: false })
  live(true)
  expect(seen.ai.canAccept).toBe(true)
})
