import type { FileWriteResult } from '@manor/contracts'
import { NOTE_AI_MAX_CHARS } from '@manor/contracts'
import type { VaultNoteEditResult } from '@manor/client-runtime/state'
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { EditorState } from './NoteDocument'
import { applyChanges, diffNote, type NoteChange } from './noteAi'

type Scope = 'selection' | 'note'

/** Where one AI edit stands, from the ask to the accepted text. */
export type NoteAiState =
  | { phase: 'idle' }
  /** The job is out. `from` and `to` are the passage, or the whole note. */
  | { phase: 'working'; scope: Scope; from: number; to: number; instruction: string }
  /** The answer, shown as a diff. `accepting` while its save is out. */
  | { phase: 'proposal'; scope: Scope; changes: readonly NoteChange[]; instruction: string; accepting: boolean }
  /** Saved; the editor is putting the changes into the document. */
  | { phase: 'applying'; scope: Scope; changes: readonly NoteChange[] }
  | { phase: 'failed'; scope: Scope; message: string; at: number }

/** What the editor and the two ways in hold of the note AI. */
export interface NoteAi {
  state: NoteAiState
  /** The model in Settings, for the proposal's small print. */
  model: string
  /** Why a new ask cannot go out, empty when it can. */
  blocked: string
  /** Accept is held back while another save of this note is out. */
  canAccept: boolean
  ask: (selection: { from: number; to: number } | null, instruction: string) => void
  /** Ends a job that is still working. */
  stop: () => void
  accept: () => void
  /** Drops the proposal, or the failure notice. Does nothing while an accept is on its way. */
  reject: () => void
  /** The editor's report that the accepted changes are in the document. */
  applied: (text: string) => void
  /** The document changed under the proposal, so its offsets mean nothing now. */
  invalidate: () => void
}

interface NoteAiOptions {
  editor: EditorState | null
  setEditor: Dispatch<SetStateAction<EditorState | null>>
  live: boolean
  /** A regular save of this note is out. */
  saving: boolean
  /** The save path is refusing: a conflict, a rejection, a deleted note. */
  refused: boolean
  writeResult: FileWriteResult | null
  results: Record<string, VaultNoteEditResult> | undefined
  model: string
  onAsk: (requestId: string, note: string, selection: { from: number; to: number } | null, instruction: string) => boolean
  onForget: (requestId: string, cancel: boolean) => void
  onSave: (path: string, content: string, baseRevision: string | null) => boolean
  /** Retires the note's write slot, for a save whose answer will never come. */
  onClearWrite: () => void
  /** Re-reads the note after an accepted save, as a regular save does. */
  onSaved: (path: string) => void
}

const IDLE: NoteAiState = { phase: 'idle' }

/**
 * The note as the editor counts it. The editor reads every line break as one character,
 * so a note that came off disk with Windows line endings is counted the same way here,
 * or a selection's offsets would point at other words.
 */
const asEdited = (text: string) => text.replace(/\r\n?/g, '\n')

/**
 * The engine behind a note's comment field and its composer. It sends the note's text
 * out, turns the answer into a proposal, and on Accept saves the proposed note through
 * the editor's own revision-checked save. The document only changes once that save
 * has gone through; a stale or rejected save leaves the proposal where it is.
 */
export function useNoteAi({ editor, setEditor, live, saving, refused, writeResult, results, model, onAsk, onForget, onSave, onClearWrite, onSaved }: NoteAiOptions): NoteAi {
  const [state, setState] = useState<NoteAiState>(IDLE)
  /** The job that is out: its id, and the text and passage it was asked about. */
  const request = useRef<{ id: string; text: string; selection: { from: number; to: number } | null; instruction: string } | null>(null)
  /** The accept save that is out, and after it lands the revision it produced. */
  const save = useRef<{ text: string; revision: string | null } | null>(null)

  const end = useCallback(() => {
    if (request.current !== null) onForget(request.current.id, true)
    request.current = null
    save.current = null
    setState(IDLE)
  }, [onForget])

  // Another note, or none: whatever was out for the last one is over.
  const identity = editor === null ? null : editor.document ?? editor.path
  const endRef = useRef(end)
  endRef.current = end
  useEffect(() => () => endRef.current(), [identity])

  const answer = request.current === null ? undefined : results?.[request.current.id]
  useEffect(() => {
    const asked = request.current
    if (asked === null || answer === undefined) return
    request.current = null
    onForget(asked.id, false)
    const scope: Scope = asked.selection === null ? 'note' : 'selection'
    const at = asked.selection?.to ?? 0
    if (answer.status === 'failed') {
      setState({ phase: 'failed', scope, message: answer.message, at })
      return
    }
    if (editor === null || asEdited(editor.text) !== asked.text) {
      setState({ phase: 'failed', scope, message: 'The note changed while the AI was working. Ask again.', at })
      return
    }
    const changes = asked.selection === null
      ? diffNote(asked.text, answer.text)
      : answer.text === asked.text.slice(asked.selection.from, asked.selection.to) ? [] : [{ ...asked.selection, insert: answer.text }]
    setState(changes.length === 0
      ? { phase: 'failed', scope, message: 'The AI found nothing to change.', at }
      : { phase: 'proposal', scope, changes, instruction: asked.instruction, accepting: false })
  }, [answer, editor, onForget])

  // A dropped connection takes the answer with it; waiting on it would shimmer forever.
  useEffect(() => {
    if (live || request.current === null) return
    const asked = request.current
    request.current = null
    onForget(asked.id, false)
    setState({ phase: 'failed', scope: asked.selection === null ? 'note' : 'selection', message: 'The connection dropped before the answer came back.', at: asked.selection?.to ?? 0 })
  }, [live, onForget])

  // The accept save's answer. Saved moves on to the document; anything else leaves the
  // proposal standing, and the editor's own strip says why the note was not written.
  useEffect(() => {
    const out = save.current
    if (out === null || out.revision !== null || writeResult === null) return
    if (writeResult.status === 'saved') {
      save.current = { ...out, revision: writeResult.revision }
      setState((current) => current.phase === 'proposal' ? { phase: 'applying', scope: current.scope, changes: current.changes } : current)
      return
    }
    save.current = null
    setState((current) => current.phase === 'proposal' ? { ...current, accepting: false } : current)
  }, [writeResult])

  // The answer to an accept save can be lost: the connection dropped, or another dock's
  // save took the one write slot. The proposal comes back usable. Accepting again goes
  // through the revision check, which refuses it if the first save did land.
  useEffect(() => {
    const out = save.current
    if (out === null || out.revision !== null) return
    if (live && (saving || writeResult !== null)) return
    save.current = null
    // A dropped connection leaves the slot waiting on an answer that is not coming.
    if (saving) onClearWrite()
    setState((current) => current.phase === 'proposal' ? { ...current, accepting: false } : current)
  }, [live, saving, writeResult, onClearWrite])

  const blocked = editor === null ? 'Open a note first.' : !live ? 'Disconnected.' : refused ? 'Resolve the save problem first.' : ''

  const ask = useCallback<NoteAi['ask']>((selection, instruction) => {
    if (editor === null || blocked !== '' || state.phase === 'working' || state.phase === 'proposal' || state.phase === 'applying') return
    const scope: Scope = selection === null ? 'note' : 'selection'
    const at = selection?.to ?? 0
    // Said here as well as on the server, so a long note is not sent only to be refused.
    const text = asEdited(editor.text)
    if (selection === null && text.length > NOTE_AI_MAX_CHARS) {
      setState({ phase: 'failed', scope, message: 'This note is too long to edit whole. Select the part to change instead.', at })
      return
    }
    const id = crypto.randomUUID()
    if (!onAsk(id, text, selection, instruction)) {
      setState({ phase: 'failed', scope, message: 'Nothing was sent, the connection is down.', at })
      return
    }
    request.current = { id, text, selection, instruction }
    setState({ phase: 'working', scope, from: selection?.from ?? 0, to: selection?.to ?? text.length, instruction })
  }, [editor, blocked, state.phase, onAsk])

  const canAccept = state.phase === 'proposal' && !state.accepting && blocked === '' && !saving

  const accept = useCallback(() => {
    if (editor === null || state.phase !== 'proposal' || !canAccept) return
    const text = applyChanges(asEdited(editor.text), state.changes)
    if (!onSave(editor.path, text, editor.base)) return
    save.current = { text, revision: null }
    setState({ ...state, accepting: true })
  }, [editor, state, canAccept, onSave])

  const applied = useCallback((text: string) => {
    const out = save.current
    save.current = null
    setState(IDLE)
    if (out === null || out.revision === null) return
    const revision = out.revision
    // `disk` is what the save wrote. Should the document differ from it, the note is
    // simply unsaved again and autosave carries the difference.
    setEditor((current) => current === null ? null : { ...current, text, disk: out.text, base: revision })
    if (editor !== null) onSaved(editor.path)
  }, [editor, setEditor, onSaved])

  // An accept save that is out can still land, so the proposal it carries is not dropped under it.
  const settling = (state.phase === 'proposal' && state.accepting) || state.phase === 'applying'
  const reject = useCallback(() => {
    if (!settling) end()
  }, [settling, end])

  return { state, model, blocked, canAccept, ask, stop: end, accept, reject, applied, invalidate: end }
}
