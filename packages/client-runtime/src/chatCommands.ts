import {
  chatCommandGoal,
  chatCommandOf,
  chatCommandRefusal,
  chatCommandRoom,
  hasConversation,
  type ChatCommandContext,
  type ThreadEvent,
} from '@manor/contracts'

/** One row of the `/` menu, the same on the Mac and the phone. */
export interface ChatCommandRow {
  command: string
  description: string
  /** Why it cannot run now. The row stays, dimmed, and says so. */
  refusal?: string
  /** Picking sends it at once. Otherwise it lands in the draft to finish typing. */
  runs: boolean
}

/** The menu's word: the whole draft is one slash and letters, so a path never opens it. */
export const commandDraft = (draft: string): string | null => /^\/([a-z]*)$/i.exec(draft)?.[1]?.toLowerCase() ?? null

export const chatCommandRows = (context: ChatCommandContext, query: string): ChatCommandRow[] => {
  if (context.room === 'none') return []
  const refused = (name: 'compact' | 'clear' | 'goal_clear') => {
    const refusal = chatCommandRefusal({ name }, context)
    return refusal === undefined ? {} : { refusal }
  }
  const { goal } = context
  const goalRefusal = context.room === 'session' ? {} : { refusal: 'Goals run in Sessions.' }
  const rows: ChatCommandRow[] = [
    { command: '/compact', description: 'Compact this conversation now', runs: true, ...refused('compact') },
    { command: '/clear', description: 'Start fresh, the transcript stays', runs: true, ...refused('clear') },
    goal === undefined
      ? { command: '/goal', description: 'Give this Session a goal', runs: false, ...goalRefusal }
      : { command: '/goal', description: 'Show this Session’s goal', runs: true },
    ...(goal?.own === true && !goal.reached
      ? [{ command: '/goal clear', description: 'Remove this goal', runs: true, ...refused('goal_clear') }]
      : []),
  ]
  return rows.filter((row) => row.command.slice(1).startsWith(query))
}

/** Why this draft, sent now as a command, would be refused. Undefined for any other draft. */
export const draftCommandRefusal = (
  draft: Parameters<typeof chatCommandOf>[0],
  context: ChatCommandContext,
): string | undefined => {
  const command = chatCommandOf(draft)
  return command === undefined ? undefined : chatCommandRefusal(command, context)
}

/** A composer without a chat behind it, such as a side chat, runs no commands. */
export const NO_CHAT_COMMANDS: ChatCommandContext = { room: 'none', hasConversation: false, busy: false, goal: undefined }

/** The draft stage: nothing held yet, and no goal until the Session exists. */
export const stageCommandContext = (session: boolean): ChatCommandContext =>
  ({ room: session ? 'session' : 'chat', hasConversation: false, busy: false, goal: undefined })

export const chatCommandContext = (
  chat: Parameters<typeof chatCommandRoom>[0],
  project: Parameters<typeof chatCommandRoom>[1],
  events: readonly ThreadEvent[],
  handoffs: readonly (Parameters<typeof chatCommandGoal>[0] & { workChatId: string | null })[],
  busy: boolean,
): ChatCommandContext => {
  const handoff = handoffs.find((row) => row.workChatId === chat.id)
  return {
    room: chatCommandRoom(chat, project),
    hasConversation: hasConversation(events),
    busy,
    goal: handoff === undefined ? undefined : chatCommandGoal(handoff),
  }
}
