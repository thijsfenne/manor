import type {
  BackgroundWait,
  ChatOverride,
  DocumentUpload,
  FileAttachment,
  ImageAttachment,
  LiveContext,
  MessageReply,
  InlineQuote,
  PageContextAttachment,
  ServerMessage,
  SubagentSummary,
  ThreadEvent,
  TurnState,
  Usage,
} from '@manor/contracts'
import {
  withOptimisticOverrides,
  type OptimisticChatOverride,
} from './optimisticOverrides'

/**
 * One streamed assistant message inside a live turn. A provider turn may contain
 * several of these around tool calls, and each becomes its own durable bubble.
 */
export interface LiveMessage {
  messageId: string
  text: string
}
/** A turn that exists on the wire until its durable turn_result lands. */
export interface LiveTurn {
  turnId: string
  agentId: string
  messages: LiveMessage[]
  state: TurnState
  /**
   * The server's clock when the turn started, which is what the elapsed timer
   * counts from. Client arrival time would restart the timer on every reconnect
   * and read "2s" for a turn that has been working for eight minutes.
   */
  startedAt: number
  /** The turn answered and only waits on background work it started. */
  background?: BackgroundWait
  /** The CLI's context reading between requests, and whether it compacts right now. */
  context?: LiveContext
}

/**
 * A message the user just sent, on screen before the server has written it down.
 * It exists until the server's durable echo lands. Active DMs write immediately;
 * sequential room queues may keep this copy visible until their turn starts.
 */
export type PendingDocument = Pick<DocumentUpload, 'name' | 'mime'>

export interface PendingMessage {
  key: string
  text: string
  images: ImageAttachment[]
  /** Text files riding along, the same ones the bubble will show once it settles. */
  files: FileAttachment[]
  /** PDF and Word files the server is still reading; the settled bubble shows how far it got. */
  documents?: PendingDocument[]
  pageContexts: PageContextAttachment[]
  replyTo?: MessageReply
  quotes?: InlineQuote[]
}

export interface ThreadState {
  events: ThreadEvent[]
  usage: Record<string, Usage>
  /** Session-only model/effort pins per agent id, set from the composer. */
  overrides: Record<string, ChatOverride>
  /** Last complete override document received from the server. */
  overrideBase: Record<string, ChatOverride>
  /** Local echoes still waiting for their request answer, in click order. */
  optimisticOverrides: OptimisticChatOverride[]
  liveTurns: LiveTurn[]
  /** Sent, not yet durable. Dropped as soon as the real event arrives. */
  pending: PendingMessage[]
  /** False until the first snapshot lands, so the UI can tell empty from unknown. */
  hasSnapshot: boolean
  /**
   * A fresh snapshot has been asked for while this thread is already on screen, which
   * happens when a reconnect re-reads a thread nobody dropped. What is here stays
   * visible — it is still the last truth anyone had — but a snapshot is the whole truth
   * for a chat and clears `pending` when it lands, so anything sent in the meantime
   * would lose its bubble until the turn writes the message down. The one flag both
   * halves read, marked exactly like `askRepoFile` and `askVaultFile` mark theirs.
   */
  refreshing: boolean
  /**
   * A child thread's own stored row from its snapshot. The sidebar's recent list is
   * fresher while it carries the child; this describes one it no longer does.
   */
  subagent?: SubagentSummary
}

export const emptyThread: ThreadState = {
  events: [],
  usage: {},
  overrides: {},
  overrideBase: {},
  optimisticOverrides: [],
  liveTurns: [],
  pending: [],
  hasSnapshot: false,
  refreshing: false,
}

/** Everything that carries a chatId and changes exactly one thread. */
export type ThreadMessage = Extract<ServerMessage, { type: 'event' | 'delta' | 'turn_state' | 'turn_background' | 'turn_context' | 'usage' | 'chat_overrides' }>

/** Drops the oldest optimistic copy of a text, and only that one. */
function withoutPending(pending: PendingMessage[], text: string): PendingMessage[] {
  const at = pending.findIndex((message) => message.text === text)
  return at === -1 ? pending : [...pending.slice(0, at), ...pending.slice(at + 1)]
}

// Like the durable row projection, this index follows the immutable event array.
// Live deltas reuse it; an append or snapshot gets a fresh index, and old arrays
// can be collected without keeping a second persistent copy of thread state.
const durableIndexCache = new WeakMap<ThreadEvent[], {
  ended: Set<string>
  messages: Map<string, Set<string>>
}>()

function durableIndex(events: ThreadEvent[]) {
  const cached = durableIndexCache.get(events)
  if (cached !== undefined) return cached
  const ended = new Set<string>()
  const messages = new Map<string, Set<string>>()
  for (const event of events) {
    if (event.type === 'turn_result') {
      ended.add(event.turnId)
    } else if (event.type === 'system_note' && event.turnId !== undefined && event.kind !== 'info') {
      ended.add(event.turnId)
    } else if (event.type === 'agent_message') {
      // Legacy messages represented an entire completed turn.
      if (event.messageId === undefined) ended.add(event.turnId)
      else {
        let ids = messages.get(event.turnId)
        if (ids === undefined) {
          ids = new Set()
          messages.set(event.turnId, ids)
        }
        ids.add(event.messageId)
      }
    }
  }
  const index = { ended, messages }
  durableIndexCache.set(events, index)
  return index
}

/** A completed turn must never grow a streamed bubble again. */
export const hasDurableResult = (events: ThreadEvent[], turnId: string) =>
  durableIndex(events).ended.has(turnId)

/**
 * The questions this turn asked that still hold it, from the durable record. What a
 * reload has instead of the socket traffic it missed, so a chat that was waiting on
 * The user before the window closed is still waiting on the user after it opens. A steering
 * message to the turn means the user wrote instead of answering: the server stops letting
 * the questions asked before it hold the turn (`supersede`), and the next directory
 * says what still waits.
 */
export function unansweredAsks(events: ThreadEvent[], turnId: string): string[] {
  const answered = new Set(answeredAsks(events))
  let open: string[] = []
  for (const event of events) {
    if (event.type === 'user_input_request' && event.turnId === turnId && !answered.has(event.requestId)) open.push(event.requestId)
    else if (event.type === 'user_message' && event.steersTurnId === turnId) open = []
  }
  return open
}

export function answeredAsks(events: ThreadEvent[]): string[] {
  return events.filter((event) => event.type === 'user_input_response').map((event) => event.requestId)
}

export const hasDurableMessage = (events: ThreadEvent[], turnId: string, messageId: string) =>
  durableIndex(events).messages.get(turnId)?.has(messageId) === true

/** One chat's transcript. Chat routing happens above this; here the chat is a given. */
export function reduceThread(state: ThreadState, msg: ThreadMessage, now: number): ThreadState {
  switch (msg.type) {
    case 'event': {
      const event = msg.event
      const existing = state.events.findIndex((known) => known.id === event.id)
      if (existing !== -1) {
        const current = state.events[existing]
        // A reaction lands, changes or goes as a patched copy of the message it sits on.
        if ((current?.type === 'user_message' && event.type === 'user_message' &&
          (current.dispatchState !== event.dispatchState || current.reaction?.emoji !== event.reaction?.emoji)) ||
          (current?.type === 'agent_message' && event.type === 'agent_message' && current.reaction?.emoji !== event.reaction?.emoji)) {
          const events = [...state.events]
          events[existing] = event
          return { ...state, events }
        }
        // A turn closes before its memory judgment and daily-log lines exist; both
        // arrive later as a patched copy of its result.
        if (current?.type === 'turn_result' && event.type === 'turn_result' &&
          (JSON.stringify(current.memoryChanges) !== JSON.stringify(event.memoryChanges) ||
            JSON.stringify(current.memoryTrace) !== JSON.stringify(event.memoryTrace))) {
          const events = [...state.events]
          events[existing] = event
          return { ...state, events }
        }
        if (
          current === undefined ||
          current.type !== 'system_note' ||
          event.type !== 'system_note' ||
          // An undone memory write keeps its words; only its mark changes.
          (current.kind === event.kind && current.text === event.text &&
            current.projectFileWrite?.undone === event.projectFileWrite?.undone)
        ) return state
        const events = [...state.events]
        events[existing] = event
        return { ...state, events }
      }
      const events = [...state.events, event]
      // The durable message is the same message: the optimistic copy goes the moment
      // it lands, matched on text and oldest first, so no send is ever shown twice.
      const pending =
        event.type === 'user_message' ? withoutPending(state.pending, event.text) : state.pending
      const liveTurns = (() => {
        if (event.type === 'turn_result') {
          return state.liveTurns.filter((turn) => turn.turnId !== event.turnId)
        }
        if (event.type !== 'agent_message') return state.liveTurns
        if (event.messageId === undefined) {
          return state.liveTurns.filter((turn) => turn.turnId !== event.turnId)
        }
        return state.liveTurns.map((turn) =>
          turn.turnId === event.turnId
            ? { ...turn, messages: turn.messages.filter((message) => message.messageId !== event.messageId) }
            : turn,
        )
      })()
      return { ...state, events, liveTurns, pending }
    }

    case 'delta': {
      if (
        hasDurableResult(state.events, msg.turnId) ||
        hasDurableMessage(state.events, msg.turnId, msg.messageId)
      ) return state
      const known = state.liveTurns.some((turn) => turn.turnId === msg.turnId)
      if (!known) {
        // A delta can outrun its turn_state; treat it as the start of the turn.
        const turn: LiveTurn = {
          turnId: msg.turnId,
          agentId: msg.agentId,
          messages: [{ messageId: msg.messageId, text: msg.text }],
          state: 'running',
          startedAt: now,
        }
        return { ...state, liveTurns: [...state.liveTurns, turn] }
      }
      return {
        ...state,
        liveTurns: state.liveTurns.map((turn) => {
          if (turn.turnId !== msg.turnId) return turn
          const hasMessage = turn.messages.some((message) => message.messageId === msg.messageId)
          return {
            ...turn,
            messages: hasMessage
              ? turn.messages.map((message) =>
                  message.messageId === msg.messageId ? { ...message, text: message.text + msg.text } : message,
                )
              : [...turn.messages, { messageId: msg.messageId, text: msg.text }],
          }
        }),
      }
    }

    case 'turn_state': {
      if (msg.state === 'running') {
        if (hasDurableResult(state.events, msg.turnId)) return state
        const known = state.liveTurns.some((turn) => turn.turnId === msg.turnId)
        if (known) {
          // A turn opened by an early delta learns its real start time here.
          return {
            ...state,
            liveTurns: state.liveTurns.map((turn) =>
              turn.turnId === msg.turnId
                ? {
                    ...turn,
                    state: 'running',
                    startedAt: msg.startedAt ?? turn.startedAt,
                    ...(msg.reset === true ? { messages: [] } : {}),
                  }
                : turn,
            ),
          }
        }
        const turn: LiveTurn = {
          turnId: msg.turnId,
          agentId: msg.agentId,
          messages: [],
          state: 'running',
          // The server's start time when it sent one; arrival time is the fallback
          // for a delta that outran its turn_state.
          startedAt: msg.startedAt ?? now,
        }
        return { ...state, liveTurns: [...state.liveTurns, turn] }
      }
      // Terminal states only keep unpersisted partial messages on screen. Completed
      // messages already live in events, so an empty live shell can go.
      const liveTurns = state.liveTurns
        .map((turn) => (turn.turnId === msg.turnId ? { ...turn, state: msg.state } : turn))
        .filter((turn) => turn.turnId !== msg.turnId || turn.messages.length > 0)
      return { ...state, liveTurns }
    }

    case 'turn_background': {
      const waiting = msg.agents + msg.commands > 0
      if (!state.liveTurns.some((turn) => turn.turnId === msg.turnId && (waiting || turn.background !== undefined))) return state
      return {
        ...state,
        liveTurns: state.liveTurns.map((turn) => {
          if (turn.turnId !== msg.turnId) return turn
          if (waiting) return { ...turn, background: { agents: msg.agents, commands: msg.commands } }
          const { background: _ended, ...rest } = turn
          return rest
        }),
      }
    }

    case 'turn_context': {
      // Only a turn still on screen takes a reading; one that already ended has its result.
      const at = state.liveTurns.findIndex((turn) => turn.turnId === msg.turnId)
      if (at === -1 || hasDurableResult(state.events, msg.turnId)) return state
      const liveTurns = [...state.liveTurns]
      liveTurns[at] = { ...liveTurns[at]!, context: msg.context }
      return { ...state, liveTurns }
    }

    case 'usage':
      return { ...state, usage: msg.perAgent }

    case 'chat_overrides':
      return {
        ...state,
        overrideBase: msg.perAgent,
        overrides: withOptimisticOverrides(msg.perAgent, state.optimisticOverrides),
      }
  }
}
