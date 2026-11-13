import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentConfig, AgentDraft } from '@manor/contracts'
import { cleanDraft, draftOf } from '../../persona'
import { useRequest, type RequestEvents } from '../../useRequest'
import type { ConnectionStatus } from '../../useWorkspace'

/** How long typing rests before it is saved. A switch or a pick saves at once. */
export const TYPING_SAVE_MS = 600

export type SaveState =
  | { kind: 'saved' }
  | { kind: 'saving' }
  /** Not sent: the draft breaks a rule the server holds too. Fixing it saves. */
  | { kind: 'held'; text: string }
  /** Sent and refused, or never sent. The draft stays as typed. */
  | { kind: 'failed'; text: string }

const OFFLINE = 'Not saved, the connection is down. It saves once it is back.'

/** A draft as the server would store it, its keys sorted so a patch's key order never reads as a change. */
const key = (draft: AgentDraft) => JSON.stringify(cleanDraft(draft), (_name, value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
    : value)

/** How long a closed panel's queued save waits for the save ahead of it to be answered. */
export const QUEUED_SAVE_WAIT_MS = 10_000

/**
 * Sends `send` once the request `outstanding` is answered, or now when nothing is out.
 * For a panel closing with an edit queued: the server runs saves side by side, so a
 * second one sent beside the first could land before it and be overwritten. Any answer
 * releases it, a refusal too, since the queued draft may be the fix. An answer the
 * connection dropped releases it after a wait, so it is never stranded.
 */
export function sendAfter(events: RequestEvents, outstanding: string | null, send: () => void) {
  if (outstanding === null) {
    send()
    return
  }
  const release = () => {
    window.clearTimeout(timer)
    stop()
    send()
  }
  const timer = window.setTimeout(release, QUEUED_SAVE_WAIT_MS)
  const stop = events.subscribe((response) => {
    if (response.requestId === outstanding && (response.type === 'ack' || response.type === 'notice')) release()
  })
}

/** The rules answered here, because sending an empty name to be told it is empty is a round trip for nothing. */
function heldBy(draft: AgentDraft): string | null {
  if (draft.name.trim() === '') return 'Not saved yet: an agent needs a name.'
  if (draft.character.trim() === '') return 'Not saved yet: an agent needs instructions.'
  return null
}

/**
 * One agent's settings, saved as they change. Edits land in a local draft at once and
 * reach the server one save at a time: a change made while a save is out rides on the
 * next one, so the last word is always the user's latest. The roster's copy replaces
 * the draft only when it says something this panel did not send, and never over an
 * unsaved edit. A save whose answer the connection dropped is given up, and the
 * draft goes out again once the connection is back.
 */
export function useAgentAutosave(
  agent: AgentConfig,
  status: ConnectionStatus,
  requestEvents: RequestEvents,
  onSave: (draft: AgentDraft, requestId: string) => boolean,
) {
  const { start, cancel } = useRequest(requestEvents)
  const [draft, setDraft] = useState(() => draftOf(agent))
  const [state, setState] = useState<SaveState>({ kind: 'saved' })
  const latest = useRef(draft)
  // An edit not sent yet; a save on the wire; what that save said.
  const dirty = useRef(false)
  const inFlight = useRef(false)
  const sent = useRef(key(draft))
  const timer = useRef<number | undefined>(undefined)
  const outstanding = useRef<string | null>(null)

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    if (!dirty.current || inFlight.current) return
    const problem = heldBy(latest.current)
    if (problem !== null) {
      setState({ kind: 'held', text: problem })
      return
    }
    const payload = cleanDraft(latest.current)
    dirty.current = false
    const ok = start((requestId) => {
      outstanding.current = requestId
      return onSave(payload, requestId)
    }, {
      onAck: () => {
        inFlight.current = false
        if (dirty.current) flush()
        else setState({ kind: 'saved' })
      },
      onNotice: (notice) => {
        inFlight.current = false
        dirty.current = true
        setState({ kind: 'failed', text: notice.text })
      },
    })
    if (!ok) {
      dirty.current = true
      setState({ kind: 'failed', text: OFFLINE })
      return
    }
    inFlight.current = true
    sent.current = key(payload)
    setState({ kind: 'saving' })
  }, [onSave, start])

  /** `typing` waits for a pause; anything else saves now. */
  const edit = useCallback((patch: Partial<AgentDraft> | ((current: AgentDraft) => AgentDraft), typing = false) => {
    const next = typeof patch === 'function' ? patch(latest.current) : { ...latest.current, ...patch }
    latest.current = next
    dirty.current = true
    setDraft(next)
    window.clearTimeout(timer.current)
    if (typing) timer.current = window.setTimeout(flush, TYPING_SAVE_MS)
    else flush()
  }, [flush])

  // Another window, or the interview, changed the agent: take it unless an edit is pending.
  const incoming = key(draftOf(agent))
  useEffect(() => {
    if (incoming === sent.current || dirty.current || inFlight.current) return
    const next = draftOf(agent)
    latest.current = next
    sent.current = incoming
    setDraft(next)
    setState({ kind: 'saved' })
    // Keyed on the stored agent only; the draft is read as it stands at that moment.
  }, [incoming])

  useEffect(() => {
    if (status !== 'live') {
      if (!inFlight.current) return
      cancel()
      inFlight.current = false
      outstanding.current = null
      dirty.current = true
      setState({ kind: 'failed', text: OFFLINE })
    } else if (dirty.current) flush()
    // Keyed on the connection only; flush reads the draft as it stands.
  }, [status])

  // An edit not sent yet when the panel closes still goes out, behind a save still out.
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  useEffect(() => () => {
    window.clearTimeout(timer.current)
    if (!dirty.current || heldBy(latest.current) !== null) return
    const payload = cleanDraft(latest.current)
    const save = onSaveRef.current
    sendAfter(requestEvents, inFlight.current ? outstanding.current : null, () => save(payload, crypto.randomUUID()))
    // Runs once, on close; the request events outlive the panel.
  }, [])

  return { draft, state, edit, flush }
}
