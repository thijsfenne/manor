import { mailBareAddress, type MailCard, type MailLabel, type MailThread, type ServerMessage } from '@manor/contracts'

/**
 * The Mail door as the client holds it. The host's `mail_state` is the truth; an Archive
 * or its Undo still in flight is laid over it by `mailCards`, so the card leaves or
 * returns at once, and a refused one puts the list back as the host has it.
 */

export type MailSnapshot = Extract<ServerMessage, { type: 'mail_state' }>

export type MailDraft = Omit<Extract<ServerMessage, { type: 'mail_draft' }>, 'type'>

export type MailOutcome = Omit<Extract<ServerMessage, { type: 'mail_result' }>, 'type' | 'requestId'>

/** An Archive or its Undo the client sent and the host has not yet answered. */
export interface PendingMailMove {
  requestId: string
  kind: 'archive' | 'unarchive'
  threadId: string
}

export interface MailState {
  /** The last `mail_state`; null until the host first answers `mail_load`. */
  snapshot: MailSnapshot | null
  /** Threads read this run, by thread id. A reopened card shows this while it is read again. */
  threads: Record<string, MailThread>
  /** Why the latest read of a thread failed, by thread id. */
  threadErrors: Record<string, string>
  /** Reply drafts by draft id. `text` is always the whole draft so far. */
  drafts: Record<string, MailDraft>
  /** The answer to each Archive, Undo and Send, by request id. */
  results: Record<string, MailOutcome>
  /** In the order they were sent. */
  pending: PendingMailMove[]
  /** Cards an Archive took out, by thread id, so its Undo can show them at once. */
  archived: Record<string, MailCard>
}

export const NO_MAIL_YET: MailState = {
  snapshot: null,
  threads: {},
  threadErrors: {},
  drafts: {},
  results: {},
  pending: [],
  archived: {},
}

type MailServerMessage = Extract<ServerMessage, { type: 'mail_state' | 'mail_thread' | 'mail_draft' | 'mail_result' }>

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const { [key]: _gone, ...rest } = record
  return rest
}

/** Puts a card back where its time places it; the list is newest first. */
function withCard(cards: MailCard[], card: MailCard): MailCard[] {
  if (cards.some((entry) => entry.threadId === card.threadId)) return cards
  const index = cards.findIndex((entry) => entry.at < card.at)
  return index === -1 ? [...cards, card] : [...cards.slice(0, index), card, ...cards.slice(index)]
}

function moved(cards: MailCard[], move: PendingMailMove, archived: MailState['archived']): MailCard[] {
  if (move.kind === 'archive') {
    return cards.some((card) => card.threadId === move.threadId)
      ? cards.filter((card) => card.threadId !== move.threadId)
      : cards
  }
  const card = archived[move.threadId]
  return card === undefined ? cards : withCard(cards, card)
}

const NO_CARDS: MailCard[] = []

/** The cards to show: the host's list with every move in flight applied. */
export function mailCards(state: MailState): MailCard[] {
  return state.pending.reduce(
    (cards, move) => moved(cards, move, state.archived),
    state.snapshot?.cards ?? NO_CARDS,
  )
}

export function reduceMail(state: MailState, msg: MailServerMessage): MailState {
  switch (msg.type) {
    // A repeat of what is already held keeps every identity, so nothing repaints.
    case 'mail_state':
      return state.snapshot !== null && JSON.stringify(state.snapshot) === JSON.stringify(msg)
        ? state
        : { ...state, snapshot: msg }
    case 'mail_thread': {
      if (msg.result.status === 'error') {
        return { ...state, threadErrors: { ...state.threadErrors, [msg.threadId]: msg.result.message } }
      }
      const held = state.threads[msg.threadId]
      const same = held !== undefined && JSON.stringify(held) === JSON.stringify(msg.result.thread)
      const threadErrors = without(state.threadErrors, msg.threadId)
      if (same && threadErrors === state.threadErrors) return state
      return {
        ...state,
        threads: same ? state.threads : { ...state.threads, [msg.threadId]: msg.result.thread },
        threadErrors,
      }
    }
    case 'mail_draft': {
      // A frame that was under way when the draft ended or was stopped does not restart it.
      const held = state.drafts[msg.draftId]
      if (held !== undefined && held.status !== 'streaming' && msg.status === 'streaming') return state
      const { type: _type, ...draft } = msg
      return { ...state, drafts: { ...state.drafts, [msg.draftId]: draft } }
    }
    case 'mail_result': {
      const { type: _type, requestId, ...outcome } = msg
      const results = { ...state.results, [requestId]: outcome }
      const move = state.pending.find((entry) => entry.requestId === requestId)
      if (move === undefined) return { ...state, results }
      // An accepted move becomes part of the list itself, so the card does not flash
      // back before the host's next `mail_state`. A refused one simply stops being applied.
      const snapshot = state.snapshot === null || !msg.ok
        ? state.snapshot
        : { ...state.snapshot, cards: moved(state.snapshot.cards, move, state.archived) }
      return { ...state, snapshot, results, pending: state.pending.filter((entry) => entry !== move) }
    }
  }
}

function withCardsChanged(state: MailState, change: (card: MailCard) => MailCard): MailState {
  if (state.snapshot === null) return state
  let changed = false
  const cards = state.snapshot.cards.map((card) => {
    const next = change(card)
    if (next !== card) changed = true
    return next
  })
  return changed ? { ...state, snapshot: { ...state.snapshot, cards } } : state
}

/** Opening a thread clears its dot here; the mailbox is never told it was read. */
export function openedMailThread(state: MailState, threadId: string): MailState {
  return withCardsChanged(state, (card) => card.threadId === threadId && card.unread ? { ...card, unread: false } : card)
}

/** A label the user sets carries no triage reason. */
export function labelledMailThread(state: MailState, threadId: string, label: MailLabel): MailState {
  return withCardsChanged(state, (card) => {
    if (card.threadId !== threadId) return card
    const { reason: _reason, ...rest } = card
    return { ...rest, label }
  })
}

/** Every card from the sender follows the link; null removes it. */
export function linkedMailSender(state: MailState, address: string, projectId: string | null): MailState {
  const sender = mailBareAddress(address)
  if (sender === undefined) return state
  return withCardsChanged(state, (card) => {
    if (mailBareAddress(card.from.address) !== sender || (card.projectId ?? null) === projectId) return card
    const { projectId: _projectId, ...rest } = card
    return projectId === null ? rest : { ...rest, projectId }
  })
}

export function archivingMailThread(state: MailState, requestId: string, threadId: string): MailState {
  const card = mailCards(state).find((entry) => entry.threadId === threadId)
  return {
    ...state,
    archived: card === undefined ? state.archived : { ...state.archived, [threadId]: card },
    pending: [...state.pending, { requestId, kind: 'archive', threadId }],
  }
}

export function unarchivingMailThread(state: MailState, requestId: string, threadId: string): MailState {
  return { ...state, pending: [...state.pending, { requestId, kind: 'unarchive', threadId }] }
}

export function startingMailDraft(state: MailState, draftId: string, threadId: string): MailState {
  return { ...state, drafts: { ...state.drafts, [draftId]: { draftId, threadId, status: 'streaming', text: '' } } }
}

/** A stopped draft keeps the text it had reached. */
export function stoppedMailDraft(state: MailState, draftId: string): MailState {
  const draft = state.drafts[draftId]
  if (draft?.status !== 'streaming') return state
  return { ...state, drafts: { ...state.drafts, [draftId]: { ...draft, status: 'done' } } }
}

/**
 * For a new socket: an answer still owed will not come, so no move stays applied and no
 * draft stays streaming. The next `mail_state` says how the mailbox really stands.
 */
export function mailAfterReconnect(state: MailState): MailState {
  const streaming = Object.values(state.drafts).filter((draft) => draft.status === 'streaming')
  if (state.pending.length === 0 && streaming.length === 0) return state
  return {
    ...state,
    pending: [],
    drafts: {
      ...state.drafts,
      ...Object.fromEntries(streaming.map((draft) => [draft.draftId, { ...draft, status: 'error' as const }])),
    },
  }
}
