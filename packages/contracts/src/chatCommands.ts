/**
 * The composer's commands, `/compact`, `/clear` and `/goal`. They never reach a model
 * as text: the server takes them before a message exists. One parser and one refusal
 * table live here, so the server, the desktop menu and the phone menu cannot disagree
 * on what a command is or why it is unavailable.
 *
 * A command is the whole message. `/compact the logs`, `/clear the cache`, `/goal/foo`
 * and any path stay ordinary messages, and so does anything sent with an attachment,
 * a quote or a reply, because that carries content a command would drop.
 */

/** The longest objective, in characters; refused before anything changes. */
export const GOAL_OBJECTIVE_MAX = 4000

export type ChatCommand =
  | { name: 'compact' }
  | { name: 'clear' }
  | { name: 'goal_show' }
  | { name: 'goal_clear' }
  | { name: 'goal_set'; objective: string }

const GOAL_COMMAND = /^\/goal(?:\s+([\s\S]*))?$/i

export const parseChatCommand = (text: string): ChatCommand | undefined => {
  const typed = text.trim()
  if (/^\/compact$/i.test(typed)) return { name: 'compact' }
  if (/^\/clear$/i.test(typed)) return { name: 'clear' }
  const goal = GOAL_COMMAND.exec(typed)
  if (goal === null) return undefined
  const objective = goal[1]?.trim() ?? ''
  if (objective.length === 0) return { name: 'goal_show' }
  return objective.toLowerCase() === 'clear' ? { name: 'goal_clear' } : { name: 'goal_set', objective }
}

/** Where a command stands: Sessions hold goals, `chat` rooms only have a context. */
export type ChatCommandRoom = 'session' | 'chat' | 'none'

export const chatCommandRoom = (
  chat: { id: string; kind: string; routineId?: string | null },
  project: { threadChatId?: string | undefined } | undefined,
): ChatCommandRoom => {
  if (chat.kind === 'side' || chat.kind === 'pair' || chat.kind === 'subagent') return 'none'
  if (chat.kind !== 'project' || project?.threadChatId === chat.id) return 'chat'
  return (chat.routineId ?? null) === null ? 'session' : 'chat'
}

export interface ChatCommandGoal {
  objective: string
  /** Set by `/goal` in this Session, so `/goal clear` may remove it. An accepted card ends by Settle. */
  own: boolean
  /** The lead already reported a result. */
  reached: boolean
}

const COMMAND_GOAL_TURN = 'goal_'

/** The source turn of a goal `/goal` set; a card's handoff carries the turn that proposed it. */
export const commandGoalTurn = (id: string): string => `${COMMAND_GOAL_TURN}${id}`

export const isCommandGoal = (handoff: { sourceTurnId: string }): boolean => handoff.sourceTurnId.startsWith(COMMAND_GOAL_TURN)

/** What the commands need of a Session's handoff, on the server and in both menus. */
export const chatCommandGoal = (handoff: {
  task?: string | undefined
  kickoff?: string | undefined
  sourceTurnId: string
  goalReachedAt?: number | undefined
}): ChatCommandGoal => ({
  objective: handoff.task ?? handoff.kickoff ?? '',
  own: isCommandGoal(handoff),
  reached: handoff.goalReachedAt !== undefined,
})

export interface ChatCommandContext {
  room: ChatCommandRoom
  /** Whether a model holds anything since the last `/clear`. */
  hasConversation: boolean
  /** A turn, a queued message or background work runs here. */
  busy: boolean
  goal: ChatCommandGoal | undefined
}

export const CHAT_COMMAND_NOT_HERE = 'Commands do not run here.'
export const CHAT_COMMAND_BUSY = 'Wait for the running work to finish, or stop it first.'
export const GOALS_RUN_IN_SESSIONS = 'Goals run in Sessions.'

/** A whole message becomes a command only when it carries nothing but the words. */
export const chatCommandOf = (message: {
  text: string
  images?: readonly unknown[] | undefined
  files?: readonly unknown[] | undefined
  uploads?: readonly unknown[] | undefined
  documents?: readonly unknown[] | undefined
  pageContexts?: readonly unknown[] | undefined
  replyTo?: unknown
  quotes?: readonly unknown[] | undefined
}): ChatCommand | undefined => {
  const { text, replyTo } = message
  const attached = [message.images, message.files, message.uploads, message.documents, message.pageContexts, message.quotes]
  if (replyTo !== undefined) return undefined
  return attached.some((list) => (list?.length ?? 0) > 0) ? undefined : parseChatCommand(text)
}

/**
 * Why this command cannot run now, or undefined when it can. Mid-turn commands refuse:
 * Manor steers additions and does not queue, and a command is never an addition. Only
 * the read of the current goal applies at once, because reading changes nothing.
 */
export const chatCommandRefusal = (command: ChatCommand, context: ChatCommandContext): string | undefined => {
  if (context.room === 'none') return CHAT_COMMAND_NOT_HERE
  switch (command.name) {
    case 'compact':
      if (context.busy) return CHAT_COMMAND_BUSY
      return context.hasConversation ? undefined : 'Nothing to compact yet.'
    case 'clear':
      if (context.busy) return CHAT_COMMAND_BUSY
      return context.hasConversation ? undefined : 'Nothing to clear yet.'
    case 'goal_show':
      if (context.room !== 'session') return GOALS_RUN_IN_SESSIONS
      return context.goal === undefined ? 'No goal yet. Type /goal and what this Session should finish.' : undefined
    case 'goal_clear':
      if (context.room !== 'session') return GOALS_RUN_IN_SESSIONS
      if (context.goal === undefined) return 'This Session has no goal.'
      if (!context.goal.own) return 'This goal came from an accepted card. Settle the Session to end it.'
      if (context.goal.reached) return 'This goal already has a result.'
      return context.busy ? CHAT_COMMAND_BUSY : undefined
    case 'goal_set':
      if (context.room !== 'session') return GOALS_RUN_IN_SESSIONS
      if (context.goal !== undefined) return 'This Session already has a goal.'
      if ([...command.objective].length > GOAL_OBJECTIVE_MAX) return `Keep the goal under ${GOAL_OBJECTIVE_MAX} characters.`
      return context.busy ? CHAT_COMMAND_BUSY : undefined
  }
}

/** The quiet marker `/clear` leaves, and what `system_note.contextBoundary` marks. */
export const CONTEXT_CLEARED_NOTE = 'Context cleared. Earlier messages stay here, the model starts fresh.'
export const SIDE_CLEAR_FAILED_NOTE = 'This side chat did not clear with the conversation. It still remembers.'

type BoundaryEvent = { id: string; type: string; contextBoundary?: { keepEventIds: readonly string[] } | undefined }

const lastBoundary = (events: readonly BoundaryEvent[]): number => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'system_note' && event.contextBoundary !== undefined) return index
  }
  return -1
}

/**
 * The events a model may read: everything after the newest `/clear`, plus what that
 * marker kept, which is an open goal's kickoff. The transcript itself never shrinks.
 */
export const contextEvents = <T extends BoundaryEvent>(events: readonly T[]): T[] => {
  const boundary = lastBoundary(events)
  if (boundary === -1) return [...events]
  const kept = new Set(events[boundary]?.contextBoundary?.keepEventIds ?? [])
  return events.filter((event, index) => index > boundary || kept.has(event.id))
}

/** A rolling summary written from before the newest `/clear` is gone for the model. */
export const summaryInContext = <S extends { throughEventId: string }>(
  summary: S | undefined,
  events: readonly BoundaryEvent[],
): S | undefined => {
  if (summary === undefined) return undefined
  const boundary = lastBoundary(events)
  if (boundary === -1) return summary
  return events.findIndex((event) => event.id === summary.throughEventId) > boundary ? summary : undefined
}

/** Whether a model holds anything since the newest `/clear`. */
export const hasConversation = (events: readonly (BoundaryEvent & { dispatchState?: string | undefined })[]): boolean =>
  contextEvents(events).some((event) => event.type === 'agent_message' ||
    (event.type === 'user_message' && event.dispatchState !== 'pending'))
